import ErpNext from "@services/frappe/ErpNext"
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

  return upsert(
    new BridgeTransferRequest({
      requestId: eventObject.id,
      transactionType: BridgeTransferRequestTransactionType.Topup,
      status: BridgeTransferRequestStatus.FiatReceived,
      amount: String(eventObject.amount),
      currency: String(eventObject.currency),
      developerFee:
        asOptionalString(receipt?.developer_fee) ??
        asOptionalString(eventObject.developer_fee) ??
        "0",
      initialAmount: asOptionalString(receipt?.initial_amount),
      subtotalAmount: asOptionalString(receipt?.subtotal_amount),
      finalAmount: asOptionalString(receipt?.final_amount),
      bridgeCustomerId: eventObject.on_behalf_of,
      bridgeTransferId: eventObject.id,
      ibexTxHash: receipt?.destination_tx_hash,
      sourceEventId: eventId,
      sourceEventType: `deposit.${eventObject.state ?? "unknown"}`,
      sourceSystemsSeen: ["bridge_deposit"],
      rawPayload,
    }),
  )
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
