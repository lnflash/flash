import type { WalletType } from "@domain/wallets"
import type { WalletCurrency } from "@domain/shared"
import { Account, Wallet } from "@services/mongoose/schema"
import { toObjectId, fromObjectId } from "@services/mongoose/utils"

import type { OwnedWalletSnapshotDependencies } from "./owned-wallet-snapshot"

/** Projected Mongo metadata reads only; no provider clients or app routing. */
export const ownedWalletSnapshotDependencies = (): OwnedWalletSnapshotDependencies => ({
  account: async (id) => {
    const value = await Account.findOne(
      { _id: toObjectId(id) },
      { _id: 1, id: 1, kratosUserId: 1, defaultWalletId: 1 },
    ).lean()
    if (!value) return new Error("Owned wallet metadata is unavailable")
    return {
      id: fromObjectId<AccountId>(value._id),
      uuid: value.id as AccountUuid,
      kratosUserId: value.kratosUserId as UserId,
      defaultWalletId: value.defaultWalletId as WalletId,
    }
  },
  wallets: async (id) => {
    const values = await Wallet.find(
      { _accountId: toObjectId(id) },
      { id: 1, _accountId: 1, currency: 1, type: 1 },
    )
      .limit(1001)
      .lean()
    return values.map((value) => ({
      id: value.id as WalletId,
      accountId: fromObjectId<AccountId>(value._accountId),
      currency: value.currency as WalletCurrency,
      type: value.type as WalletType,
    }))
  },
})
