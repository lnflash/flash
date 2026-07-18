import ErpNext from "@services/frappe/ErpNext"
import { baseLogger } from "@services/logger"
import { BridgeTransferRequestUpsertError } from "@services/frappe/errors"

import {
  BridgeTransferRequest,
  BridgeTransferRequestStatus,
  BridgeTransferRequestTransactionType,
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
