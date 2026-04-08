import { BridgeDepositAddress } from "./schema"
import { RepositoryError } from "@domain/errors"

export interface BridgeDepositAddressData {
  accountId: string
  rail: string
  currency: string
  address: string
  ibexReceiveInfoId: string
}

/**
 * Returns the active deposit address for an account, or null if none.
 */
export const findActiveDepositAddress = async (
  accountId: string,
): Promise<BridgeDepositAddressData | null | RepositoryError> => {
  try {
    const record = await BridgeDepositAddress.findOne({ accountId, isActive: true })
    if (!record) return null
    return {
      accountId: record.accountId,
      rail: record.rail,
      currency: record.currency,
      address: record.address,
      ibexReceiveInfoId: record.ibexReceiveInfoId,
    }
  } catch (error) {
    return new RepositoryError(String(error))
  }
}

/**
 * Deactivates any existing deposit address for the account and inserts the new one.
 * Idempotent: if address already exists and is active, returns it unchanged.
 */
export const upsertDepositAddress = async (
  data: BridgeDepositAddressData,
): Promise<BridgeDepositAddressData | RepositoryError> => {
  try {
    // Check if exact same address already exists and is active
    const existing = await BridgeDepositAddress.findOne({
      accountId: data.accountId,
      address: data.address,
      isActive: true,
    })
    if (existing) {
      return {
        accountId: existing.accountId,
        rail: existing.rail,
        currency: existing.currency,
        address: existing.address,
        ibexReceiveInfoId: existing.ibexReceiveInfoId,
      }
    }

    // Deactivate any previous active address for this account
    await BridgeDepositAddress.updateMany(
      { accountId: data.accountId, isActive: true },
      { isActive: false },
    )

    // Insert new record
    const record = await BridgeDepositAddress.create({ ...data, isActive: true })
    return {
      accountId: record.accountId,
      rail: record.rail,
      currency: record.currency,
      address: record.address,
      ibexReceiveInfoId: record.ibexReceiveInfoId,
    }
  } catch (error) {
    return new RepositoryError(String(error))
  }
}

/**
 * Deactivates the active deposit address for an account (e.g. on rail change).
 */
export const deactivateDepositAddress = async (
  accountId: string,
): Promise<void | RepositoryError> => {
  try {
    await BridgeDepositAddress.updateMany(
      { accountId, isActive: true },
      { isActive: false },
    )
  } catch (error) {
    return new RepositoryError(String(error))
  }
}
