import { WalletCurrency } from "@domain/shared"

import { recordIbexCryptoReceive } from "@app/bridge/record-crypto-receive"
import { listWalletsByAccountId } from "@app/wallets"

import { findAccountByBridgeCustomerId } from "@services/bridge/account-lookup"
import { findBridgeDepositByTxHash } from "@services/bridge/reconciliation"
import Ibex from "@services/ibex/client"
import { baseLogger } from "@services/logger"
import { findProcessedIbexCryptoReceiveTxHashes } from "@services/mongoose/ibex-crypto-receive-log"
import { BridgeDeposits } from "@services/mongoose/schema"

const logger = baseLogger.child({ module: "match-ibex-deposits" })

// Bridge deposits this recent are matched; older ones are left to ops.
export const MATCH_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000
// IBEX can settle the credit just before Bridge's payment_processed event
// lands, so credits are read from a little before the deposit.
const CREDIT_LEAD_MS = 15 * 60 * 1000
// A user is told about a deposit only while it is news: a late match (first
// run after deploy, IBEX outage) records it silently.
export const NOTIFY_WITHIN_MS = 24 * 60 * 60 * 1000

export const IBEX_CRYPTO_RECEIVE_TYPE_ID = 9
const TRANSACTIONS_PAGE_SIZE = 50
// Stops a runaway read; a USDT wallet has far fewer credits in a week.
const MAX_PAGES = 20

type IbexAccountTransaction = {
  id?: string
  createdAt?: string
  settledAt?: string | null
  amount?: number
  transactionTypeId?: number
  // The IBEX account, which is the Flash wallet id.
  accountId?: string
  status?: string
}

type PendingDeposit = {
  transferId: string
  customerId: string
  destinationTxHash: string
  createdAt: Date
}

export type IbexDepositMatchSummary = {
  // payment_processed deposits in the lookback whose receive is unprocessed
  pending: number
  matched: number
  alreadyProcessed: number
  // no IBEX credit with the deposit's tx hash yet; the next run retries
  unmatched: number
  // a lookup or IBEX read failed, or recording failed; the next run retries
  failures: number
}

const settledTime = (tx: IbexAccountTransaction): number => {
  const raw = tx.settledAt || tx.createdAt
  return raw ? new Date(raw).getTime() : NaN
}

// The wallet's crypto receives settled at or after `since`, newest first.
const readCryptoReceivesSince = async (
  walletId: string,
  since: number,
): Promise<IbexAccountTransaction[] | Error> => {
  const receives: IbexAccountTransaction[] = []
  const seen = new Set<string>()
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await Ibex.getAccountTransactions({
      account_id: walletId,
      limit: TRANSACTIONS_PAGE_SIZE,
      page,
      sort: "settledAt",
    })
    if (batch instanceof Error) return batch

    let oldest = Infinity
    for (const tx of batch as IbexAccountTransaction[]) {
      const at = settledTime(tx)
      if (!Number.isNaN(at)) oldest = Math.min(oldest, at)
      if (!tx.id || seen.has(tx.id)) continue
      seen.add(tx.id)
      if (tx.transactionTypeId !== IBEX_CRYPTO_RECEIVE_TYPE_ID) continue
      if (Number.isNaN(at) || at < since) continue
      receives.push(tx)
    }
    if (batch.length < TRANSACTIONS_PAGE_SIZE || oldest < since) return receives
  }
  logger.warn({ walletId, pages: MAX_PAGES }, "page cap reached reading IBEX credits")
  return receives
}

const loadPendingDeposits = async (
  since: Date,
): Promise<{ pending: PendingDeposit[]; alreadyProcessed: number } | Error> => {
  const rows = (await BridgeDeposits.find(
    {
      state: "payment_processed",
      destinationTxHash: { $type: "string", $ne: "" },
      createdAt: { $gte: since },
    },
    { transferId: 1, customerId: 1, destinationTxHash: 1, createdAt: 1 },
  )
    .sort({ createdAt: 1 })
    .lean()) as PendingDeposit[]

  // One row per tx hash: a redelivered event is stored as another row.
  const byHash = new Map<string, PendingDeposit>()
  for (const row of rows) {
    const key = row.destinationTxHash.toLowerCase()
    if (!byHash.has(key)) byHash.set(key, row)
  }

  const processed = await findProcessedIbexCryptoReceiveTxHashes([...byHash.keys()])
  if (processed instanceof Error) return processed

  const pending = [...byHash.entries()]
    .filter(([key]) => !processed.has(key))
    .map(([, row]) => row)
  return { pending, alreadyProcessed: byHash.size - pending.length }
}

/**
 * Matches Bridge virtual-account deposits to the IBEX credits they produced
 * (ENG-891). IBEX credits these deposits natively but never tells Flash, so
 * the ERPNext deposit row stayed at Fiat Received and the user got no
 * deposit notification.
 *
 * For each payment_processed deposit of the last week whose receive is not
 * yet processed: read the customer's USDT wallet's IBEX crypto receives
 * (type 9) since the deposit, fetch each one's on-chain tx hash, and on an
 * exact hash match record the receive through recordIbexCryptoReceive, the
 * same path as the IBEX Hub webhook. No amount or time matching: the tx hash is
 * the join key.
 *
 * Never throws. Per-deposit problems are counted and retried by the next run;
 * an Error is returned only when the deposits could not be read at all.
 */
export const matchBridgeDepositsToIbex = async ({
  now = new Date(),
  lookbackMs = MATCH_LOOKBACK_MS,
}: {
  now?: Date
  lookbackMs?: number
} = {}): Promise<IbexDepositMatchSummary | Error> => {
  const summary: IbexDepositMatchSummary = {
    pending: 0,
    matched: 0,
    alreadyProcessed: 0,
    unmatched: 0,
    failures: 0,
  }

  let loaded: Awaited<ReturnType<typeof loadPendingDeposits>>
  try {
    loaded = await loadPendingDeposits(new Date(now.getTime() - lookbackMs))
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
  if (loaded instanceof Error) return loaded
  summary.pending = loaded.pending.length
  summary.alreadyProcessed = loaded.alreadyProcessed

  const byCustomer = new Map<string, PendingDeposit[]>()
  for (const deposit of loaded.pending) {
    const list = byCustomer.get(deposit.customerId) ?? []
    list.push(deposit)
    byCustomer.set(deposit.customerId, list)
  }

  for (const [customerId, deposits] of byCustomer) {
    try {
      await matchCustomerDeposits({ customerId, deposits, now, summary })
    } catch (error) {
      logger.error({ error, customerId }, "matching a customer's deposits threw")
      summary.failures += deposits.length
    }
  }

  logger.info(summary, "Bridge deposit to IBEX credit match finished")
  return summary
}

const matchCustomerDeposits = async ({
  customerId,
  deposits,
  now,
  summary,
}: {
  customerId: string
  deposits: PendingDeposit[]
  now: Date
  summary: IbexDepositMatchSummary
}): Promise<void> => {
  const lookup = await findAccountByBridgeCustomerId(customerId)
  if (lookup.kind === "lookup_failed") {
    logger.error({ error: lookup.error, customerId }, "account lookup failed")
    summary.failures += deposits.length
    return
  }
  if (lookup.kind === "not_found" || !lookup.account.bridgeEthereumAddress) {
    // The reconciler files these as orphans once they are old enough.
    logger.warn(
      { customerId, found: lookup.kind === "found" },
      "no account with a Bridge deposit address for this customer",
    )
    summary.unmatched += deposits.length
    return
  }
  const { account } = lookup
  const address = account.bridgeEthereumAddress as string

  const wallets = await listWalletsByAccountId(account.id)
  if (wallets instanceof Error) {
    logger.error({ error: wallets, accountId: account.id }, "wallet list failed")
    summary.failures += deposits.length
    return
  }
  const usdtWallet = wallets.find((w) => w.currency === WalletCurrency.Usdt)
  if (!usdtWallet) {
    logger.warn({ accountId: account.id }, "account has no USDT wallet")
    summary.unmatched += deposits.length
    return
  }

  const since =
    Math.min(...deposits.map((d) => new Date(d.createdAt).getTime())) - CREDIT_LEAD_MS
  const credits = await readCryptoReceivesSince(usdtWallet.id, since)
  if (credits instanceof Error) {
    logger.error({ error: credits, walletId: usdtWallet.id }, "IBEX credit read failed")
    summary.failures += deposits.length
    return
  }

  const wanted = new Set(deposits.map((d) => d.destinationTxHash.toLowerCase()))
  const creditByHash = new Map<string, IbexAccountTransaction>()
  let detailFailures = 0
  for (const credit of credits) {
    if (creditByHash.size === wanted.size) break
    const networkId = await Ibex.getTransactionNetworkId(credit.id as string)
    if (networkId instanceof Error) {
      logger.warn(
        { error: networkId, ibexTransactionId: credit.id },
        "IBEX transaction details read failed",
      )
      detailFailures++
      continue
    }
    if (!networkId) continue
    const key = networkId.toLowerCase()
    if (wanted.has(key)) creditByHash.set(key, credit)
  }

  for (const deposit of deposits) {
    const credit = creditByHash.get(deposit.destinationTxHash.toLowerCase())
    if (!credit) {
      // A failed details read may have hidden the match; retry next run.
      if (detailFailures > 0) summary.failures++
      else summary.unmatched++
      continue
    }

    // A credit without a positive amount would be recorded as a settled
    // zero and marked processed, so it would never be corrected; retry it.
    if (typeof credit.amount !== "number" || !(credit.amount > 0)) {
      logger.error(
        {
          txHash: deposit.destinationTxHash,
          ibexTransactionId: credit.id,
          amount: credit.amount,
        },
        "matched IBEX credit has no usable amount",
      )
      summary.failures++
      continue
    }

    const settledAt = settledTime(credit)
    const result = await recordIbexCryptoReceive({
      txHash: deposit.destinationTxHash,
      address,
      amount: credit.amount,
      ibexTransactionId: credit.id,
      notifyUser:
        !Number.isNaN(settledAt) && now.getTime() - settledAt <= NOTIFY_WITHIN_MS,
      rawPayload: {
        source: "ibex_deposit_matcher",
        ibexTransactionId: credit.id,
        bridgeTransferId: deposit.transferId,
        settledAt: credit.settledAt ?? credit.createdAt,
      },
    })

    if (result instanceof Error || result.status === "error") {
      logger.error(
        {
          result: result instanceof Error ? result.message : result,
          txHash: deposit.destinationTxHash,
          ibexTransactionId: credit.id,
        },
        "recording a matched IBEX credit failed",
      )
      summary.failures++
    } else if (result.status === "already_processed") {
      summary.alreadyProcessed++
    } else {
      logger.info(
        {
          txHash: deposit.destinationTxHash,
          ibexTransactionId: credit.id,
          accountId: account.id,
        },
        "matched a Bridge deposit to its IBEX credit",
      )
      summary.matched++
    }
  }
}

export type BridgeDepositMatchResult =
  // the deposit's IBEX credit was found and recorded
  | "recorded"
  | "already_processed"
  // no IBEX credit with the deposit's tx hash yet: IBEX Hub's webhook records
  // it when the credit lands, the hourly matcher if that delivery is lost
  | "no_ibex_credit"
  // a read or the recording failed; the hourly matcher retries
  | "failed"

/**
 * Records one Bridge virtual-account deposit the moment Bridge reports it
 * payment_processed (ENG-891), by the same per-customer read and tx hash join
 * as the hourly matcher. IBEX usually credits the USDT a minute or two before
 * Bridge's event lands, so the credit is often already there; when it is not,
 * IBEX Hub's webhook records the deposit once it is.
 *
 * Never throws.
 */
export const matchBridgeDepositNow = async ({
  transferId,
  customerId,
  destinationTxHash,
  now = new Date(),
}: {
  transferId: string
  customerId: string
  destinationTxHash: string
  now?: Date
}): Promise<BridgeDepositMatchResult> => {
  const log = logger.child({ transferId, txHash: destinationTxHash })
  try {
    const processed = await findProcessedIbexCryptoReceiveTxHashes([
      destinationTxHash.toLowerCase(),
    ])
    if (processed instanceof Error) {
      log.warn({ error: processed }, "processed check failed")
      return "failed"
    }
    if (processed.has(destinationTxHash.toLowerCase())) return "already_processed"

    const summary: IbexDepositMatchSummary = {
      pending: 1,
      matched: 0,
      alreadyProcessed: 0,
      unmatched: 0,
      failures: 0,
    }
    await matchCustomerDeposits({
      customerId,
      deposits: [{ transferId, customerId, destinationTxHash, createdAt: now }],
      now,
      summary,
    })
    if (summary.matched > 0) return "recorded"
    if (summary.alreadyProcessed > 0) return "already_processed"
    if (summary.failures > 0) return "failed"
    return "no_ibex_credit"
  } catch (error) {
    log.error({ error }, "matching a reported Bridge deposit threw")
    return "failed"
  }
}

export type IbexCreditSignalResult =
  // the credit was recorded against its Bridge deposit
  | "recorded"
  | "already_processed"
  // not a completed crypto receive: nothing to do
  | "ignored"
  // no Bridge deposit carries the credit's tx hash yet (Bridge's event can land
  // after IBEX's), or the credit is not a Bridge deposit; the hourly matcher
  // picks up the first case
  | "no_bridge_deposit"
  // the deposit and the credit do not line up; logged for ops
  | "mismatch"
  // a read or the recording failed; the hourly matcher retries
  | "failed"

/**
 * Records one IBEX credit as soon as IBEX Hub reports it (ENG-891). The
 * organization webhook only says that transaction `ibexTransactionId`
 * changed; per IBEX's guidance the body is not trusted, so the transaction
 * and its tx hash are read back from IBEX, and the credit is recorded only
 * when a payment_processed Bridge deposit has that tx hash and the credit
 * landed on that customer's USDT wallet. The same join and the same
 * recordIbexCryptoReceive as the hourly matcher, which stays the backstop for
 * any delivery IBEX drops (at most once) or that arrives before Bridge's event.
 *
 * Never throws.
 */
export const recordIbexCreditSignal = async ({
  ibexTransactionId,
  webhookId,
  now = new Date(),
}: {
  ibexTransactionId: string
  webhookId?: string
  now?: Date
}): Promise<IbexCreditSignalResult> => {
  const log = logger.child({ ibexTransactionId, webhookId })
  try {
    const credit = (await Ibex.getTransactionDetails(
      ibexTransactionId as IbexTransactionId,
    )) as IbexAccountTransaction | Error
    if (credit instanceof Error) {
      log.warn({ error: credit }, "IBEX transaction read failed")
      return "failed"
    }
    if (
      credit.transactionTypeId !== IBEX_CRYPTO_RECEIVE_TYPE_ID ||
      credit.status !== "completed"
    ) {
      return "ignored"
    }

    const networkId = await Ibex.getTransactionNetworkId(ibexTransactionId)
    if (networkId instanceof Error) {
      log.warn({ error: networkId }, "IBEX transaction details read failed")
      return "failed"
    }
    if (!networkId) {
      log.warn("completed IBEX crypto receive has no tx hash")
      return "failed"
    }

    const deposit = (await findBridgeDepositByTxHash(networkId)) as PendingDeposit | null
    if (!deposit) {
      log.info(
        { txHash: networkId },
        "no Bridge deposit has this IBEX credit's tx hash yet",
      )
      return "no_bridge_deposit"
    }

    const lookup = await findAccountByBridgeCustomerId(deposit.customerId)
    if (lookup.kind === "lookup_failed") {
      log.error({ error: lookup.error }, "account lookup failed")
      return "failed"
    }
    if (lookup.kind === "not_found" || !lookup.account.bridgeEthereumAddress) {
      log.warn(
        { txHash: networkId, found: lookup.kind === "found" },
        "no account with a Bridge deposit address for this deposit's customer",
      )
      return "mismatch"
    }
    const { account } = lookup
    const address = account.bridgeEthereumAddress as string

    const wallets = await listWalletsByAccountId(account.id)
    if (wallets instanceof Error) {
      log.error({ error: wallets, accountId: account.id }, "wallet list failed")
      return "failed"
    }
    const usdtWallet = wallets.find((w) => w.currency === WalletCurrency.Usdt)
    if (!usdtWallet || usdtWallet.id !== credit.accountId) {
      log.error(
        { txHash: networkId, accountId: account.id, creditAccountId: credit.accountId },
        "IBEX credit did not land on the Bridge deposit's USDT wallet",
      )
      return "mismatch"
    }

    // As in the matcher: a zero would be recorded and marked processed for good.
    if (typeof credit.amount !== "number" || !(credit.amount > 0)) {
      log.error({ amount: credit.amount }, "IBEX credit has no usable amount")
      return "failed"
    }

    const settledAt = settledTime(credit)
    const result = await recordIbexCryptoReceive({
      txHash: deposit.destinationTxHash,
      address,
      amount: credit.amount,
      ibexTransactionId,
      notifyUser:
        !Number.isNaN(settledAt) && now.getTime() - settledAt <= NOTIFY_WITHIN_MS,
      rawPayload: {
        source: "ibex_hub_webhook",
        webhookId,
        ibexTransactionId,
        bridgeTransferId: deposit.transferId,
        settledAt: credit.settledAt ?? credit.createdAt,
      },
    })
    if (result instanceof Error || result.status === "error") {
      log.error(
        { result: result instanceof Error ? result.message : result },
        "recording a reported IBEX credit failed",
      )
      return "failed"
    }
    if (result.status === "already_processed") return "already_processed"

    log.info(
      { txHash: deposit.destinationTxHash, accountId: account.id },
      "recorded a Bridge deposit as IBEX reported its credit",
    )
    return "recorded"
  } catch (error) {
    log.error({ error }, "recording a reported IBEX credit threw")
    return "failed"
  }
}
