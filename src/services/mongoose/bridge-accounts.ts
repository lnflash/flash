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
      { accountId: { $eq: data.accountId } },
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
    const record = await BridgeVirtualAccount.findOne({ accountId: { $eq: accountId } })
    return record || new RepositoryError("Virtual account not found")
  } catch (error) {
    return new RepositoryError(String(error))
  }
}

export const findVirtualAccountByBridgeId = async (bridgeId: BridgeVirtualAccountId) => {
  try {
    const record = await BridgeVirtualAccount.findOne({
      bridgeVirtualAccountId: { $eq: bridgeId },
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
      {
        bridgeExternalAccountId: { $eq: bridgeExternalAccountId },
        accountId: { $eq: accountId },
      },
      {
        $setOnInsert: { bridgeExternalAccountId, accountId },
        $set: { ...metadata, status: status ?? "pending", updatedAt: new Date() },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    )
    const defaultResult = await ensureDefaultExternalAccount(data.accountId)
    if (defaultResult instanceof Error) return defaultResult

    return (
      (await BridgeExternalAccount.findOne({
        accountId: { $eq: data.accountId },
        bridgeExternalAccountId: { $eq: bridgeExternalAccountId },
      })) ?? record
    )
  } catch (error) {
    return new RepositoryError(String(error))
  }
}

export const findExternalAccountsByAccountId = async (accountId: string) => {
  try {
    const records = await BridgeExternalAccount.find({ accountId: { $eq: accountId } })
    return records
  } catch (error) {
    return new RepositoryError(String(error))
  }
}

export const ensureDefaultExternalAccount = async (accountId: string) => {
  try {
    const currentDefault = await BridgeExternalAccount.findOne({
      accountId: { $eq: accountId },
      isDefault: true,
      status: { $ne: "failed" },
    })
    if (currentDefault) return currentDefault

    const nextDefault = await BridgeExternalAccount.findOne({
      accountId: { $eq: accountId },
      status: { $ne: "failed" },
    }).sort({ createdAt: 1 })
    if (!nextDefault) {
      await BridgeExternalAccount.updateMany(
        { accountId: { $eq: accountId } },
        { isDefault: false, updatedAt: new Date() },
      )
      return null
    }

    await BridgeExternalAccount.updateMany(
      { accountId: { $eq: accountId } },
      { isDefault: false, updatedAt: new Date() },
    )

    return await BridgeExternalAccount.findOneAndUpdate(
      { _id: nextDefault._id },
      { isDefault: true, updatedAt: new Date() },
      { new: true },
    )
  } catch (error) {
    return new RepositoryError(String(error))
  }
}

export const setDefaultExternalAccount = async (
  accountId: string,
  bridgeExternalAccountId: string,
) => {
  try {
    const target = await BridgeExternalAccount.findOne({
      accountId: { $eq: accountId },
      bridgeExternalAccountId: { $eq: bridgeExternalAccountId },
      status: { $ne: "failed" },
    })
    if (!target) return new RepositoryError("External account not found")

    await BridgeExternalAccount.updateMany(
      { accountId: { $eq: accountId } },
      { isDefault: false, updatedAt: new Date() },
    )

    const record = await BridgeExternalAccount.findOneAndUpdate(
      { _id: target._id },
      { isDefault: true, updatedAt: new Date() },
      { new: true },
    )
    return record || new RepositoryError("External account not found")
  } catch (error) {
    return new RepositoryError(String(error))
  }
}

export const deleteExternalAccount = async (
  accountId: string,
  bridgeExternalAccountId: string,
) => {
  try {
    const target = await BridgeExternalAccount.findOne({
      accountId: { $eq: accountId },
      bridgeExternalAccountId: { $eq: bridgeExternalAccountId },
      status: { $ne: "failed" },
    })
    if (!target) return new RepositoryError("External account not found")

    const record = await BridgeExternalAccount.findOneAndUpdate(
      { _id: target._id },
      { status: "failed", isDefault: false, updatedAt: new Date() },
      { new: true },
    )
    if (!record) return new RepositoryError("External account not found")

    if (target.isDefault) {
      const defaultResult = await ensureDefaultExternalAccount(accountId)
      if (defaultResult instanceof Error) return defaultResult
    }

    return record
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
      accountId: { $eq: accountId },
      status: { $ne: "failed" },
    }
    if (bridgeExternalAccountIds.length > 0) {
      filter.bridgeExternalAccountId = { $nin: bridgeExternalAccountIds }
    }

    return await BridgeExternalAccount.updateMany(filter, {
      status: "failed",
      isDefault: false,
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
      { bridgeExternalAccountId: { $eq: bridgeId } },
      {
        status,
        ...(status === "failed" ? { isDefault: false } : {}),
        updatedAt: new Date(),
      },
      { new: true },
    )
    if (!record) return new RepositoryError("External account not found")

    if (status === "failed") {
      const defaultResult = await ensureDefaultExternalAccount(record.accountId)
      if (defaultResult instanceof Error) return defaultResult
    }

    return record
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
        accountId: { $eq: data.accountId },
        externalAccountId: { $eq: data.externalAccountId },
        amount: { $eq: data.amount },
        currency: { $eq: data.currency },
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
      accountId: { $eq: accountId },
      externalAccountId: { $eq: externalAccountId },
      amount: { $eq: amount },
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
      { _id: { $eq: id }, status: "pending", bridgeTransferId: { $exists: false } },
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
      { _id: { $eq: id }, status: "submitted", ibexPayoutId: { $exists: false } },
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
      { _id: { $eq: id }, status: "submitted", ibexPayoutId: { $exists: false } },
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
    const records = await BridgeWithdrawal.find({ accountId: { $eq: accountId } }).sort({
      createdAt: -1,
    })
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
    const truncatedReason = truncateBridgeFailureReason(failureReason)
    const update =
      truncatedReason === undefined
        ? { $set: { status, updatedAt: new Date() } }
        : { $set: { status, updatedAt: new Date(), failureReason: truncatedReason } }

    const record = await BridgeWithdrawal.findOneAndUpdate(
      {
        bridgeTransferId: { $eq: bridgeTransferId },
        status: { $in: ["submitted", "usdt_sent"] },
      },
      update,
      { new: true },
    )
    if (record) return record

    const existing = await BridgeWithdrawal.findOne({
      bridgeTransferId: { $eq: bridgeTransferId },
    })
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
    const record = await BridgeWithdrawal.findOne({
      bridgeTransferId: { $eq: transferId },
    })
    return record || new RepositoryError("Withdrawal not found")
  } catch (error) {
    return new RepositoryError(String(error))
  }
}

export const findWithdrawalById = async (id: string) => {
  try {
    const record = await BridgeWithdrawal.findOne({ _id: { $eq: id } })
    return record || new RepositoryError("Withdrawal not found")
  } catch (error) {
    return new RepositoryError(String(error))
  }
}

export const cancelWithdrawal = async (accountId: string, withdrawalId: string) => {
  try {
    const record = await BridgeWithdrawal.findOneAndUpdate(
      {
        _id: { $eq: withdrawalId },
        accountId: { $eq: accountId },
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
