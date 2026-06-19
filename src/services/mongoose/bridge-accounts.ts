import {
  BridgeVirtualAccountId,
  BridgeExternalAccountId,
  BridgeTransferId,
} from "@domain/primitives/bridge"
import { RepositoryError } from "@domain/errors"

import { BridgeVirtualAccount, BridgeExternalAccount, BridgeWithdrawal } from "./schema"

// ============ Virtual Accounts ============

export const createVirtualAccount = async (data: {
  accountId: string
  bridgeVirtualAccountId: string
  bankName: string
  routingNumber: string
  accountNumber: string
  accountNumberLast4: string
}) => {
  try {
    // Atomic upsert: if a doc for this accountId already exists (concurrent call won the
    // race), $setOnInsert is skipped and we get back the winner's record — no duplicate.
    const record = await BridgeVirtualAccount.findOneAndUpdate(
      { accountId: data.accountId },
      { $setOnInsert: data },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    )
    return record
  } catch (error) {
    return new RepositoryError(String(error))
  }
}

export const findVirtualAccountByAccountId = async (accountId: string) => {
  try {
    const record = await BridgeVirtualAccount.findOne({ accountId })
    return record || new RepositoryError("Virtual account not found")
  } catch (error) {
    return new RepositoryError(String(error))
  }
}

export const findVirtualAccountByBridgeId = async (bridgeId: BridgeVirtualAccountId) => {
  try {
    const record = await BridgeVirtualAccount.findOne({
      bridgeVirtualAccountId: bridgeId,
    })
    return record || new RepositoryError("Virtual account not found")
  } catch (error) {
    return new RepositoryError(String(error))
  }
}

// ============ External Accounts ============

export const createExternalAccount = async (data: {
  accountId: string
  bridgeExternalAccountId: string
  bankName: string
  accountNumberLast4: string
  status?: "pending" | "verified" | "failed"
}) => {
  try {
    const { bridgeExternalAccountId, accountId, status, ...metadata } = data
    const record = await BridgeExternalAccount.findOneAndUpdate(
      { bridgeExternalAccountId, accountId },
      {
        $setOnInsert: { bridgeExternalAccountId, accountId },
        $set: { ...metadata, status: status ?? "pending", updatedAt: new Date() },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    )
    return record
  } catch (error) {
    return new RepositoryError(String(error))
  }
}

export const findExternalAccountsByAccountId = async (accountId: string) => {
  try {
    const records = await BridgeExternalAccount.find({ accountId })
    return records
  } catch (error) {
    return new RepositoryError(String(error))
  }
}

export const markExternalAccountsMissingFromBridge = async (
  accountId: string,
  bridgeExternalAccountIds: string[],
) => {
  try {
    const filter: Record<string, unknown> = {
      accountId,
      status: { $ne: "failed" },
    }
    if (bridgeExternalAccountIds.length > 0) {
      filter.bridgeExternalAccountId = { $nin: bridgeExternalAccountIds }
    }

    return await BridgeExternalAccount.updateMany(filter, {
      status: "failed",
      updatedAt: new Date(),
    })
  } catch (error) {
    return new RepositoryError(String(error))
  }
}

export const updateExternalAccountStatus = async (
  bridgeId: BridgeExternalAccountId,
  status: "pending" | "verified" | "failed",
) => {
  try {
    const record = await BridgeExternalAccount.findOneAndUpdate(
      { bridgeExternalAccountId: bridgeId },
      { status },
      { new: true },
    )
    return record || new RepositoryError("External account not found")
  } catch (error) {
    return new RepositoryError(String(error))
  }
}

// ============ Withdrawals ============

export const BRIDGE_WITHDRAWAL_NOT_FOUND = "Withdrawal not found"

export const BRIDGE_FAILURE_REASON_MAX_LENGTH = 512

export const truncateBridgeFailureReason = (
  reason: string | undefined,
): string | undefined => {
  if (reason === undefined) return undefined
  if (reason.length <= BRIDGE_FAILURE_REASON_MAX_LENGTH) return reason
  return `${reason.slice(0, BRIDGE_FAILURE_REASON_MAX_LENGTH - 3)}...`
}

export const bridgeWithdrawalRecordId = (record: {
  id?: string
  _id?: { toString(): string }
}): string => {
  if (record.id) return record.id
  if (record._id) return record._id.toString()
  return ""
}

export const createWithdrawal = async (data: {
  accountId: string
  bridgeTransferId?: string
  amount: string
  currency: string
  externalAccountId: string
  flashFeePercent: string
  flashFee: string
  estimatedBridgeFeePercent: string
  estimatedBridgeFee: string
  estimatedGasBuffer: string
  estimatedCustomerFee: string
  status?: "pending" | "completed" | "failed"
}) => {
  try {
    const record = await BridgeWithdrawal.create(data)
    return record
  } catch (error: unknown) {
    const mongoErr = error as { code?: number }
    if (mongoErr.code === 11000) {
      const record = await BridgeWithdrawal.findOne({
        accountId: data.accountId,
        externalAccountId: data.externalAccountId,
        amount: data.amount,
        currency: data.currency,
        status: "pending",
      })
      if (record) return record
    }
    return new RepositoryError(String(error))
  }
}

export const updateWithdrawalFeeEstimates = async (
  id: string,
  fees: {
    flashFeePercent: string
    flashFee: string
    estimatedBridgeFeePercent: string
    estimatedBridgeFee: string
    estimatedGasBuffer: string
    estimatedCustomerFee: string
  },
) => {
  try {
    const record = await BridgeWithdrawal.findByIdAndUpdate(
      id,
      {
        flashFeePercent: fees.flashFeePercent,
        flashFee: fees.flashFee,
        estimatedBridgeFeePercent: fees.estimatedBridgeFeePercent,
        estimatedBridgeFee: fees.estimatedBridgeFee,
        estimatedGasBuffer: fees.estimatedGasBuffer,
        estimatedCustomerFee: fees.estimatedCustomerFee,
        updatedAt: new Date(),
      },
      { new: true },
    )
    return record || new RepositoryError("Withdrawal not found")
  } catch (error) {
    return new RepositoryError(String(error))
  }
}

export const findPendingWithdrawalWithoutTransfer = async (
  accountId: string,
  externalAccountId: string,
  amount: string,
) => {
  try {
    const record = await BridgeWithdrawal.findOne({
      accountId,
      externalAccountId,
      amount,
      bridgeTransferId: { $exists: false },
      status: "pending",
    })
    return record // null when no in-flight row exists
  } catch (error) {
    return new RepositoryError(String(error))
  }
}

export const updateWithdrawalTransferId = async (
  id: string,
  bridgeTransferId: string,
  amount: string,
  currency: string,
  bridgeDepositAddress?: string,
  receiptFees?: {
    bridgeDeveloperFee?: string
    bridgeExchangeFee?: string
    subtotalAmount?: string
    finalAmount?: string
  },
) => {
  try {
    const update: Record<string, unknown> = {
      bridgeTransferId,
      amount,
      currency,
      bridgeDeveloperFee: receiptFees?.bridgeDeveloperFee,
      bridgeExchangeFee: receiptFees?.bridgeExchangeFee,
      subtotalAmount: receiptFees?.subtotalAmount,
      finalAmount: receiptFees?.finalAmount,
      status: "submitted",
      updatedAt: new Date(),
    }
    if (bridgeDepositAddress) update.bridgeDepositAddress = bridgeDepositAddress

    const record = await BridgeWithdrawal.findOneAndUpdate(
      { _id: id, status: "pending", bridgeTransferId: { $exists: false } },
      update,
      { new: true },
    )
    return record || new RepositoryError("Withdrawal not found or already submitted")
  } catch (error) {
    return new RepositoryError(String(error))
  }
}

export const updateWithdrawalOnchainSend = async (
  id: string,
  ibexPayoutId: string | undefined,
  ibexTxHash?: string,
) => {
  try {
    const update: Record<string, unknown> = {
      status: "usdt_sent",
      updatedAt: new Date(),
    }
    if (ibexPayoutId) update.ibexPayoutId = ibexPayoutId
    if (ibexTxHash) update.ibexTxHash = ibexTxHash

    const record = await BridgeWithdrawal.findOneAndUpdate(
      { _id: id, status: "submitted", ibexPayoutId: { $exists: false } },
      update,
      { new: true },
    )
    return record || new RepositoryError("Withdrawal not found or already sent")
  } catch (error) {
    return new RepositoryError(String(error))
  }
}

export const updateWithdrawalSendFailed = async (
  id: string,
  bridgeTransferId: string,
  amount: string,
  currency: string,
  bridgeDepositAddress: string,
  failureReason: string,
) => {
  try {
    const record = await BridgeWithdrawal.findOneAndUpdate(
      { _id: id, status: "submitted", ibexPayoutId: { $exists: false } },
      {
        bridgeTransferId,
        amount,
        currency,
        bridgeDepositAddress,
        status: "send_failed",
        failureReason: truncateBridgeFailureReason(failureReason),
        updatedAt: new Date(),
      },
      { new: true },
    )
    return record || new RepositoryError("Withdrawal not found or already sent")
  } catch (error) {
    return new RepositoryError(String(error))
  }
}

export const findWithdrawalsByAccountId = async (accountId: string) => {
  try {
    const records = await BridgeWithdrawal.find({ accountId }).sort({ createdAt: -1 })
    return records
  } catch (error) {
    return new RepositoryError(String(error))
  }
}

export const updateWithdrawalStatus = async (
  bridgeTransferId: BridgeTransferId,
  status: "pending" | "completed" | "failed",
  failureReason?: string,
) => {
  try {
    const update: Record<string, unknown> = { status, updatedAt: new Date() }
    const truncatedReason = truncateBridgeFailureReason(failureReason)
    if (truncatedReason !== undefined) update.failureReason = truncatedReason

    const record = await BridgeWithdrawal.findOneAndUpdate(
      { bridgeTransferId, status: { $in: ["submitted", "usdt_sent"] } },
      update,
      { new: true },
    )
    if (record) return record

    const existing = await BridgeWithdrawal.findOne({ bridgeTransferId })
    if (!existing) return new RepositoryError(BRIDGE_WITHDRAWAL_NOT_FOUND)

    // Idempotent: duplicate webhook after we already reached this terminal status.
    if (existing.status === status) return existing

    return new RepositoryError(
      `Withdrawal already ${existing.status}, cannot transition to ${status}`,
    )
  } catch (error) {
    return new RepositoryError(String(error))
  }
}

export const findWithdrawalByBridgeTransferId = async (transferId: BridgeTransferId) => {
  try {
    const record = await BridgeWithdrawal.findOne({ bridgeTransferId: transferId })
    return record || new RepositoryError("Withdrawal not found")
  } catch (error) {
    return new RepositoryError(String(error))
  }
}

export const findWithdrawalById = async (id: string) => {
  try {
    const record = await BridgeWithdrawal.findById(id)
    return record || new RepositoryError("Withdrawal not found")
  } catch (error) {
    return new RepositoryError(String(error))
  }
}

export const cancelWithdrawal = async (accountId: string, withdrawalId: string) => {
  try {
    const record = await BridgeWithdrawal.findOneAndUpdate(
      {
        _id: withdrawalId,
        accountId,
        status: "pending",
        bridgeTransferId: { $exists: false },
      },
      { status: "cancelled", updatedAt: new Date() },
      { new: true },
    )
    return record || new RepositoryError("Withdrawal not found or cannot be cancelled")
  } catch (error) {
    return new RepositoryError(String(error))
  }
}
