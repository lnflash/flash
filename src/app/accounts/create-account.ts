import { ConfigError, getAdminAccounts, getDefaultAccountsConfig } from "@config"

import { AccountLevel } from "@domain/accounts"

import { AccountsRepository, UsersRepository } from "@services/mongoose"

import {
  createMissingCashWallets,
  defaultCashWalletCurrency,
} from "./ensure-account-wallets"

const initializeCreatedAccount = async ({
  account,
  config,
  phone,
}: {
  account: Account
  config: AccountsConfig
  phone?: PhoneNumber
}): Promise<Account | ApplicationError> => {
  // A fresh account has no wallets yet, so every configured currency is
  // created. The same helper runs on the read path for accounts left half-made
  // by an earlier IBEX failure, where it only fills the gaps (#90).
  const enabledWallets = await createMissingCashWallets({
    accountId: account.id,
    currencies: config.initialWallets,
    existingWallets: [],
  })
  if (enabledWallets instanceof Error) return enabledWallets

  // Set ETH-USDT as the active Cash Wallet while preserving USD for migration.
  const defaultWalletId = enabledWallets[defaultCashWalletCurrency]?.id

  if (defaultWalletId === undefined) {
    return new ConfigError("NoWalletsEnabledInConfigError")
  }
  account.defaultWalletId = defaultWalletId

  // TODO: improve bootstrap process
  // the script below is to dynamically attribute the editor account at runtime
  // this is only if editor is set in the config - typically only in test env
  const role = getAdminAccounts().find(({ phone: phone2 }) => phone2 === phone)?.role
  account.role = role || "user"
  // end TODO

  account.contactEnabled = account.role === "user" || account.role === "editor"

  account.statusHistory = [{ status: config.initialStatus, comment: "Initial Status" }]
  account.level = config.initialLevel

  const updatedAccount = await AccountsRepository().update(account)
  if (updatedAccount instanceof Error) return updatedAccount

  return updatedAccount
}

export const createAccountForDeviceAccount = async ({
  userId,
  deviceId,
}: {
  userId: UserId
  deviceId: DeviceId
}): Promise<Account | RepositoryError> => {
  const user = await UsersRepository().update({ id: userId, deviceId })
  if (user instanceof Error) return user

  const accountNew = await AccountsRepository().persistNew(userId)
  if (accountNew instanceof Error) return accountNew

  const levelZeroAccountsConfig = getDefaultAccountsConfig()
  levelZeroAccountsConfig.initialLevel = AccountLevel.Zero

  return initializeCreatedAccount({
    account: accountNew,
    config: levelZeroAccountsConfig,
  })
}

export const createAccountWithPhoneIdentifier = async ({
  newAccountInfo: { kratosUserId, phone },
  config,
  phoneMetadata,
}: {
  newAccountInfo: NewAccountWithPhoneIdentifier
  config: AccountsConfig
  phoneMetadata?: PhoneMetadata
}): Promise<Account | RepositoryError> => {
  const user = await UsersRepository().update({ id: kratosUserId, phone, phoneMetadata })
  if (user instanceof Error) return user

  const accountNew = await AccountsRepository().persistNew(kratosUserId)
  if (accountNew instanceof Error) return accountNew

  const account = await initializeCreatedAccount({
    account: accountNew,
    config,
    phone,
  })
  if (account instanceof Error) return account

  return account
}
