import mongoose from "mongoose"

import {
  MONGODB_CON,
  MissingBankOwnerAccountConfigError,
  MissingBtcDealerWalletConfigError,
  MissingDealerAccountConfigError,
  MissingFunderAccountConfigError,
  MissingUsdDealerWalletConfigError,
  UnknownConfigError,
  getAdminAccounts,
} from "@config"
import { WalletCurrency } from "@domain/shared"
import { lazyLoadLedgerAdmin } from "@services/ledger"
import { AccountsRepository, UsersRepository, WalletsRepository } from "@services/mongoose"
import { fromObjectId } from "@services/mongoose/utils"

import { baseLogger } from "../logger"
import { Account } from "../mongoose/schema"
import { AccountRoles, AccountStatus } from "@domain/accounts"

export const ledgerAdmin = lazyLoadLedgerAdmin({
  bankOwnerWalletResolver: async () => {
    const ownersPhone = getAdminAccounts().filter(_ => _.role === AccountRoles.bankowner)[0].phone
    const user = await UsersRepository().findByPhone(ownersPhone)
    if (user instanceof Error) throw new MissingBankOwnerAccountConfigError(`Could not find admin user with phone ${ownersPhone}`)
    const account = await AccountsRepository().findByUserId(user.id)
    if (account instanceof Error) throw new MissingBankOwnerAccountConfigError(`Could not find admin account for userId ${user.id}`)
    baseLogger.info(account.defaultWalletId, "bank owner wallet id")
    return account.defaultWalletId
  },
  dealerBtcWalletResolver: async () => {
    const user: AccountRecord | null = await Account.findOne(
      { role: "dealer" },
      { id: 1 },
    )
    if (!user) throw new MissingDealerAccountConfigError()
    // FIXME remove the use of AccountRecord when role if part of the AccountRepository
    const accountId = fromObjectId<AccountId>(user._id)
    const wallets = await WalletsRepository().listByAccountId(accountId)
    if (wallets instanceof Error) {
      baseLogger.error({ err: wallets }, "Error while listing wallets for dealer")
      throw new UnknownConfigError("Couldn't load dealer wallets")
    }
    const wallet = wallets.find((wallet) => wallet.currency === WalletCurrency.Btc)
    if (wallet === undefined) throw new MissingBtcDealerWalletConfigError()
    return wallet.id
  },
  dealerUsdWalletResolver: async () => {
    const user: AccountRecord | null = await Account.findOne(
      { role: "dealer" },
      { id: 1 },
    )
    if (!user) throw new MissingDealerAccountConfigError()
    // FIXME remove the use of AccountRecord when role if part of the AccountRepository
    const accountId = fromObjectId<AccountId>(user._id)
    const wallets = await WalletsRepository().listByAccountId(accountId)
    if (wallets instanceof Error) {
      baseLogger.error({ err: wallets }, "Error while listing wallets for dealer")
      throw new UnknownConfigError("Couldn't load dealer wallets")
    }
    const wallet = wallets.find((wallet) => wallet.currency === WalletCurrency.Usd)
    if (wallet === undefined) throw new MissingUsdDealerWalletConfigError()
    return wallet.id
  },
  funderWalletResolver: async () => {
    const result = await Account.findOne({ role: "funder" }, { defaultWalletId: 1 })
    if (!result) throw new MissingFunderAccountConfigError()
    return result.defaultWalletId
  },
})

// TODO add an event listenever if we got disconnecter from MongoDb
// after a first successful connection

export const setupMongoConnection = async (syncIndexes = false) => {
  try {
    await mongoose.connect(MONGODB_CON, { autoIndex: false })
  } catch (err) {
    baseLogger.fatal(`error connecting to mongodb`)
    throw err
  }

  try {
    mongoose.set("runValidators", true)
    if (syncIndexes) {
      for (const model in mongoose.models) {
        baseLogger.info({ model }, "Syncing indexes")
        await mongoose.models[model].syncIndexes()
      }
    }
  } catch (err) {
    baseLogger.fatal(`error setting the indexes`)
    throw err
  }

  return mongoose
}
