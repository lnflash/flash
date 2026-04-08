import { BridgeDepositAddress } from "./schema"
import { RepositoryError } from "@domain/errors"

export interface BridgeDepositAddressData {
  accountId: string
  rail: string
  currency: string
  address: string
  ibexReceiveInfoId: string
}

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

export const findActiveDepositAddressByAddress = async (
  address: string,
): Promise<BridgeDepositAddressData | null | RepositoryError> => {
  try {
    const record = await BridgeDepositAddress.findOne({ address, isActive: true })
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

export const upsertDepositAddress = async (
  data: BridgeDepositAddressData,
): Promise<BridgeDepositAddressData | RepositoryError> => {
  try {
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

    await BridgeDepositAddress.updateMany(
      { accountId: data.accountId, isActive: true },
      { isActive: false },
    )

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
