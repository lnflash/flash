import { BridgeVirtualAccount, BridgeExternalAccount, BridgeWithdrawal } from "./schema"
import {
  BridgeVirtualAccountId,
  BridgeExternalAccountId,
  BridgeTransferId,
} from "@domain/primitives/bridge"
import { RepositoryError } from "@domain/errors"

// ============ Virtual Accounts ============

export const createVirtualAccount = async (data: {
  accountId: string
  bridgeVirtualAccountId: string
  bankName: string
  routingNumber: string
  accountNumberLast4: string
}) => {
  try {
    const record = await BridgeVirtualAccount.create(data)
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
    const record = await BridgeExternalAccount.create(data)
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

export const createWithdrawal = async (data: {
  accountId: string
  bridgeTransferId: string
  amount: string
  currency: string
  externalAccountId: string
  status?: "pending" | "completed" | "failed"
}) => {
  try {
    const record = await BridgeWithdrawal.create(data)
    return record
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
) => {
  try {
    const record = await BridgeWithdrawal.findOneAndUpdate(
      { bridgeTransferId },
      { status, updatedAt: new Date() },
      { new: true },
    )
    return record || new RepositoryError("Withdrawal not found")
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
