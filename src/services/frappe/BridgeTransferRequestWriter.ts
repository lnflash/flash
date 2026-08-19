import ErpNext from "@services/frappe/ErpNext"
import { baseLogger } from "@services/logger"
import {
  BridgeTransferRequestUpsertError,
  FygaroTopupHistoryQueryError,
} from "@services/frappe/errors"

import {
  BridgeTransferRequest,
  BridgeTransferRequestStatus,
  BridgeTransferRequestTransactionType,
  EMAIL_ATTRIBUTION_SOURCE_SYSTEM,
  type FygaroTopupWindow,
} from "./models/BridgeTransferRequest"

type BridgeDepositEventObject = {
  id: string
  state?: string
  amount: string
  currency: string
  on_behalf_of: string
  deposit_id?: string
  virtual_account_id?: string
  product_type?: string
  // Virtual-account/bridge-wallet activity fields
  type?: string
  customer_id?: string
  payment_route?: {
    customer_id?: string
    type?: string
    deposit_id?: string
    transfer_id?: string
  }
  destination_payment_rail?: string
  receipt?: {
    developer_fee?: unknown
    initial_amount?: unknown
    subtotal_amount?: unknown
    final_amount?: unknown
    destination_tx_hash?: string
  }
  developer_fee?: unknown
}

const asOptionalString = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined
  return String(value)
}

const upsert = async (
  request: BridgeTransferRequest,
): Promise<true | BridgeTransferRequestUpsertError> => {
  if (!ErpNext?.upsertBridgeTransferRequest) {
    return new BridgeTransferRequestUpsertError("ERPNext client is not configured")
  }
  return ErpNext.upsertBridgeTransferRequest(request)
}

// The IBEX crypto receive settle row (`ibex:<txHash>`), when it already
// exists at Settled — i.e. the crypto side of this topup landed before this
// deposit event. Carries the credited account/wallet so the deposit row gets
// the same attribution the promotion path stamps. A lookup failure degrades
// to undefined so the deposit audit write never fails on the enrichment; the
// row just stays at Fiat Received until the crypto-receive handler (or a
// Bridge retry) promotes it.
const findSettledIbexReceive = async (
  txHash: string,
): Promise<{ accountId?: string; walletId?: string } | undefined> => {
  if (!ErpNext?.findBridgeTransferRequest) return undefined
  const doc = await ErpNext.findBridgeTransferRequest(`ibex:${txHash}`)
  if (doc instanceof Error) {
    baseLogger.warn(
      { txHash, error: doc },
      "Failed to check IBEX settle row for Bridge deposit; keeping Fiat Received",
    )
    return undefined
  }
  if (!doc || doc.status !== BridgeTransferRequestStatus.Settled) return undefined
  return { accountId: doc.account_id, walletId: doc.wallet_id }
}

export const writeBridgeDepositRequest = async ({
  eventId,
  eventObject,
  rawPayload,
}: {
  eventId: string
  eventObject: BridgeDepositEventObject
  rawPayload: unknown
}): Promise<true | BridgeTransferRequestUpsertError> => {
  const receipt = eventObject.receipt

  // Normalise: virtual_account / bridge_wallet events use different field names
  const customerId =
    eventObject.on_behalf_of ??
    eventObject.customer_id ??
    eventObject.payment_route?.customer_id
  const state = eventObject.state ?? eventObject.type ?? "unknown"
  const currency = eventObject.currency ?? "usd"
  const isVirtualAccountActivity =
    !!eventObject.type ||
    !!eventObject.virtual_account_id ||
    eventObject.product_type === "virtual_account"
  const stableRequestId =
    eventObject.deposit_id ??
    eventObject.payment_route?.deposit_id ??
    eventObject.payment_route?.transfer_id ??
    (isVirtualAccountActivity ? undefined : eventObject.id)

  if (!stableRequestId) {
    baseLogger.warn(
      { eventId, bridgeEventObjectId: eventObject.id, state },
      "Skipping Bridge deposit ERPNext audit row without stable request id",
    )
    return true
  }

  const destinationTxHash = receipt?.destination_tx_hash
  const settledReceive = destinationTxHash
    ? await findSettledIbexReceive(destinationTxHash)
    : undefined

  return upsert(
    new BridgeTransferRequest({
      requestId: stableRequestId,
      transactionType: BridgeTransferRequestTransactionType.Topup,
      status: settledReceive
        ? BridgeTransferRequestStatus.Completed
        : BridgeTransferRequestStatus.FiatReceived,
      accountId: settledReceive?.accountId,
      walletId: settledReceive?.walletId,
      amount: String(eventObject.amount),
      currency: String(currency),
      developerFee:
        asOptionalString(receipt?.developer_fee) ??
        asOptionalString(eventObject.developer_fee) ??
        "0",
      initialAmount: asOptionalString(receipt?.initial_amount),
      subtotalAmount: asOptionalString(receipt?.subtotal_amount),
      finalAmount: asOptionalString(receipt?.final_amount),
      bridgeCustomerId: customerId ?? "unknown",
      bridgeTransferId: stableRequestId,
      ibexTxHash: receipt?.destination_tx_hash,
      sourceEventId: eventId,
      sourceEventType: `deposit.${state}`,
      sourceSystemsSeen: settledReceive
        ? ["bridge_deposit", "ibex_crypto_receive"]
        : ["bridge_deposit"],
      rawPayload,
    }),
  )
}

// Called by the IBEX crypto-receive handler after it writes the settle row:
// promotes the matching deposit-side Topup row (joined on ibex_tx_hash) to
// Completed and stamps the credited account/wallet on it.
export const promoteBridgeDepositForCryptoReceive = async ({
  txHash,
  accountId,
  walletId,
}: {
  txHash: string
  accountId: AccountId
  walletId: WalletId
}): Promise<
  "completed" | "already_completed" | "not_found" | BridgeTransferRequestUpsertError
> => {
  if (!ErpNext?.completeBridgeTopupByTxHash) {
    return new BridgeTransferRequestUpsertError("ERPNext client is not configured")
  }
  return ErpNext.completeBridgeTopupByTxHash({ txHash, accountId, walletId })
}

export const writeIbexCryptoReceiveRequest = async ({
  txHash,
  address,
  amount,
  currency,
  network,
  accountId,
  walletId,
  rawPayload,
}: {
  txHash: string
  address: string
  amount: string
  currency: string
  network: string
  accountId: AccountId
  walletId: WalletId
  rawPayload: unknown
}): Promise<true | BridgeTransferRequestUpsertError> => {
  return upsert(
    new BridgeTransferRequest({
      requestId: `ibex:${txHash}`,
      transactionType: BridgeTransferRequestTransactionType.Topup,
      status: BridgeTransferRequestStatus.Settled,
      amount: String(amount),
      currency: String(currency),
      network,
      accountId,
      walletId,
      ibexTxHash: txHash,
      address,
      sourceEventId: txHash,
      sourceEventType: "crypto.receive",
      sourceSystemsSeen: ["ibex_crypto_receive"],
      rawPayload,
    }),
  )
}

// Fygaro card top-up audit row: fiat captured on Fygaro's side, recorded the
// moment the payment webhook lands. `fygaro:` prefixed request ids keep these
// rows disjoint from Bridge deposit ids and IBEX settle rows.
export const writeFygaroTopupRequest = async ({
  transactionId,
  amount,
  currency,
  accountId,
  emailAttributed,
  createdAt,
  rawPayload,
}: {
  transactionId: string
  amount: string
  currency: string
  accountId?: AccountId | string
  // True when accountId was resolved from the checkout payer email rather
  // than customReference — display-grade attribution the webhook never
  // credits from. Marked in source_systems_seen so the admin detail view
  // shows how the row got its account, and so the daily-cap sum can skip it:
  // an unverified email must never consume the named account's allowance.
  emailAttributed?: boolean
  createdAt?: string
  rawPayload: unknown
}): Promise<true | BridgeTransferRequestUpsertError> => {
  return upsert(
    new BridgeTransferRequest({
      requestId: `fygaro:${transactionId}`,
      transactionType: BridgeTransferRequestTransactionType.Topup,
      status: BridgeTransferRequestStatus.FiatReceived,
      provider: "Fygaro",
      asset: "USD",
      network: "Card",
      amount: String(amount),
      currency: String(currency),
      accountId,
      sourceEventId: transactionId,
      sourceEventType: "fygaro.payment",
      sourceSystemsSeen: emailAttributed
        ? ["fygaro_webhook", EMAIL_ATTRIBUTION_SOURCE_SYSTEM]
        : ["fygaro_webhook"],
      firstSeenAt: createdAt,
      rawPayload,
    }),
  )
}

// Gross cents this account was charged via Fygaro over the trailing 24h. Feeds
// the per-level daily top-up cap. An unconfigured ERPNext client is an error,
// not zero — the gate must fail closed rather than treat a missing history as a
// clean slate.
//
// `excludeTransactionId` drops the caller's OWN audit row, which the webhook
// writes before the credit gate runs; without it every payment double-counts
// itself. It is optional because the pre-charge check has no such row — nothing
// has been paid yet — and omitting the filter is the honest way to say so.
export const readFygaroTopupWindowLast24h = async ({
  accountId,
  excludeTransactionId,
}: {
  accountId: AccountId | string
  excludeTransactionId?: string
}): Promise<FygaroTopupWindow | FygaroTopupHistoryQueryError> => {
  if (!ErpNext?.sumFygaroTopupGrossCentsSince) {
    return new FygaroTopupHistoryQueryError("ERPNext client is not configured")
  }
  return ErpNext.sumFygaroTopupGrossCentsSince({
    accountId: String(accountId),
    since: new Date(Date.now() - 24 * 60 * 60 * 1000),
    ...(excludeTransactionId === undefined
      ? {}
      : { excludeRequestId: `fygaro:${excludeTransactionId}` }),
  })
}

// Gross-only view, for the gates that decide yes/no and have no use for when
// the window rolls. Kept as its own export so those call sites cannot start
// depending on a shape they do not need.
export const sumFygaroTopupGrossCentsLast24h = async (args: {
  accountId: AccountId | string
  excludeTransactionId?: string
}): Promise<number | FygaroTopupHistoryQueryError> => {
  const window = await readFygaroTopupWindowLast24h(args)
  return window instanceof Error ? window : window.grossCents
}

export type FygaroTopupCompletion = {
  // Whether the audit row was already promoted to Completed by a prior delivery.
  completed: boolean
  // The NET credited, in cents, when the row records one. Carried alongside the
  // boolean because the paths that ask this question are exactly the paths with
  // no fee breakdown of their own: a delivery that merely CONFIRMS an earlier
  // credit re-stamps the customer's status, and without this it would stamp
  // `credited` with no amount — against a schema that promises `netAmount` is
  // "present once credited". Undefined when the row has no final_amount (an
  // older row, or one promoted by a path that did not write the breakdown).
  netAmountCents?: number
}

// Whether this Fygaro payment was already fully processed, and for how much.
// Used as the processed-marker for webhook re-deliveries. A lookup failure
// degrades to not-completed — the credit itself is exactly-once under
// withPaymentIdempotency, so a false negative can never double-pay; it only
// costs a redundant cached-send replay.
export const readFygaroTopupCompletion = async (
  transactionId: string,
): Promise<FygaroTopupCompletion> => {
  if (!ErpNext?.findBridgeTransferRequest) return { completed: false }
  const doc = await ErpNext.findBridgeTransferRequest(`fygaro:${transactionId}`)
  if (doc instanceof Error) {
    baseLogger.warn(
      { transactionId, error: doc },
      "Failed to check Fygaro topup completion; treating as not completed",
    )
    return { completed: false }
  }
  if (doc?.status !== BridgeTransferRequestStatus.Completed) return { completed: false }

  // Frappe hands back numbers or numeric strings depending on the field type,
  // and null for an unset field — `Number(null)` is 0, which would report a
  // credited top-up as having delivered nothing. Anything unparsable or
  // non-positive is simply not reported.
  const netDollars = doc.final_amount == null ? NaN : Number(doc.final_amount)
  return {
    completed: true,
    netAmountCents:
      Number.isFinite(netDollars) && netDollars > 0
        ? Math.round(netDollars * 100)
        : undefined,
  }
}

// Called after the treasury -> user intraledger credit succeeds: promotes the
// Fygaro topup row to Completed and stamps the credited wallet plus the fee
// breakdown on it. `initialAmount` is the gross face value, `processorFee` /
// `flashFee` are the deducted fees, and `finalAmount` is the NET amount that
// was actually credited (all in USD dollars). The upsert's monotonic status
// guard makes this safe to repeat.
export const completeFygaroTopup = async ({
  transactionId,
  accountId,
  walletId,
  amount,
  currency,
  initialAmount,
  processorFee,
  flashFee,
  finalAmount,
  rawPayload,
}: {
  transactionId: string
  accountId: AccountId | string
  walletId: WalletId | string
  amount: string
  currency: string
  initialAmount?: string
  processorFee?: string
  flashFee?: string
  finalAmount?: string
  rawPayload: unknown
}): Promise<true | BridgeTransferRequestUpsertError> => {
  return upsert(
    new BridgeTransferRequest({
      requestId: `fygaro:${transactionId}`,
      transactionType: BridgeTransferRequestTransactionType.Topup,
      status: BridgeTransferRequestStatus.Completed,
      provider: "Fygaro",
      asset: "USD",
      network: "Card",
      amount: String(amount),
      currency: String(currency),
      accountId,
      walletId,
      initialAmount,
      processorFee,
      flashFee,
      finalAmount,
      sourceEventId: transactionId,
      sourceEventType: "fygaro.payment",
      sourceSystemsSeen: ["fygaro_webhook", "ibex_intraledger_credit"],
      rawPayload,
    }),
  )
}

/**
 * Record WHY a captured payment was not credited, on the row that was already
 * written when it arrived.
 *
 * Two jobs, and both matter. It is the ops-visible answer to "this customer was
 * charged, what happened" — previously reconstructable only from a Discord
 * alert. And it is what takes the row OUT of the daily-allowance sum: an
 * uncredited payment delivered no value, so it must not spend the allowance
 * that governs value delivered (see sumFygaroTopupGrossCentsSince).
 *
 * Status deliberately stays `Fiat Received`. The money really was received;
 * inventing a new status would break every existing reader, including the
 * allowance sum's own status filter.
 */
export const markFygaroTopupNotCredited = async ({
  transactionId,
  accountId,
  amount,
  currency,
  reason,
  rawPayload,
}: {
  transactionId: string
  accountId?: AccountId | string
  amount: string
  currency: string
  reason: string
  rawPayload: unknown
}): Promise<true | BridgeTransferRequestUpsertError> => {
  return upsert(
    new BridgeTransferRequest({
      requestId: `fygaro:${transactionId}`,
      transactionType: BridgeTransferRequestTransactionType.Topup,
      status: BridgeTransferRequestStatus.FiatReceived,
      provider: "Fygaro",
      asset: "USD",
      network: "Card",
      amount: String(amount),
      currency: String(currency),
      accountId,
      failureReason: reason,
      sourceEventId: transactionId,
      sourceEventType: "fygaro.payment",
      sourceSystemsSeen: ["fygaro_webhook"],
      rawPayload,
    }),
  )
}

type BridgeCashoutWriteInput = {
  transferId: string
  amount: string
  currency: string
  accountId?: AccountId | string
  sourceEventId?: string
  sourceEventType: string
  rawPayload: unknown
}

export const writeBridgeCashoutPending = async ({
  transferId,
  amount,
  currency,
  accountId,
  sourceEventId,
  sourceEventType,
  rawPayload,
}: BridgeCashoutWriteInput): Promise<true | BridgeTransferRequestUpsertError> => {
  return upsert(
    new BridgeTransferRequest({
      requestId: transferId,
      transactionType: BridgeTransferRequestTransactionType.Cashout,
      status: BridgeTransferRequestStatus.Pending,
      amount: String(amount),
      currency: String(currency),
      accountId,
      bridgeTransferId: transferId,
      sourceEventId,
      sourceEventType,
      sourceSystemsSeen: ["bridge_transfer"],
      rawPayload,
    }),
  )
}

export const writeBridgeCashoutCompleted = async ({
  transferId,
  amount,
  currency,
  accountId,
  sourceEventId,
  sourceEventType,
  rawPayload,
}: BridgeCashoutWriteInput): Promise<true | BridgeTransferRequestUpsertError> => {
  return upsert(
    new BridgeTransferRequest({
      requestId: transferId,
      transactionType: BridgeTransferRequestTransactionType.Cashout,
      status: BridgeTransferRequestStatus.Completed,
      amount: String(amount),
      currency: String(currency),
      accountId,
      bridgeTransferId: transferId,
      sourceEventId,
      sourceEventType,
      sourceSystemsSeen: ["bridge_transfer"],
      rawPayload,
    }),
  )
}

export const writeBridgeCashoutFailed = async ({
  transferId,
  amount,
  currency,
  accountId,
  sourceEventId,
  sourceEventType,
  failureReason,
  rawPayload,
}: BridgeCashoutWriteInput & {
  failureReason?: string
}): Promise<true | BridgeTransferRequestUpsertError> => {
  return upsert(
    new BridgeTransferRequest({
      requestId: transferId,
      transactionType: BridgeTransferRequestTransactionType.Cashout,
      status: BridgeTransferRequestStatus.Failed,
      amount: String(amount),
      currency: String(currency),
      accountId,
      bridgeTransferId: transferId,
      sourceEventId,
      sourceEventType,
      sourceSystemsSeen: ["bridge_transfer"],
      failureReason,
      rawPayload,
    }),
  )
}
