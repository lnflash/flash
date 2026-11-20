import { WalletCurrency } from "@domain/shared"

import { recordIbexCryptoReceive } from "@app/bridge/record-crypto-receive"
import { listWalletsByAccountId } from "@app/wallets"

import { findAccountByBridgeCustomerId } from "@services/bridge/account-lookup"
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

const IBEX_CRYPTO_RECEIVE_TYPE_ID = 9
const TRANSACTIONS_PAGE_SIZE = 50
// Stops a runaway read; a USDT wallet has far fewer credits in a week.
const MAX_PAGES = 20

type IbexAccountTransaction = {
  id?: string
  createdAt?: string
  settledAt?: string | null
  amount?: number
  transactionTypeId?: number
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
 * same path as the IBEX webhook. No amount or time matching: the tx hash is
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

    const settledAt = settledTime(credit)
    const result = await recordIbexCryptoReceive({
      txHash: deposit.destinationTxHash,
      address,
      amount: credit.amount ?? 0,
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
