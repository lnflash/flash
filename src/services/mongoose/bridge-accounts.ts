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
  bridgeTransferId?: string
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
) => {
  try {
    const record = await BridgeWithdrawal.findByIdAndUpdate(
      id,
      { bridgeTransferId, amount, currency, updatedAt: new Date() },
      { new: true },
    )
    return record || new RepositoryError("Withdrawal not found")
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
