import { ConfigError, getAdminAccounts, getDefaultAccountsConfig } from "@config"

import { WalletType } from "@domain/wallets"
import { AccountLevel } from "@domain/accounts"

import {
  AccountsRepository,
  UsersRepository,
  WalletsRepository,
} from "@services/mongoose"

import { recordExceptionInCurrentSpan } from "@services/tracing"
import { ErrorLevel, WalletCurrency } from "@domain/shared"
import Ibex from "@services/ibex/client"

const requiredCashWalletCurrencies: WalletCurrency[] = [
  WalletCurrency.Usd,
  WalletCurrency.Usdt,
]
const defaultCashWalletCurrency = WalletCurrency.Usdt
const defaultCashWalletReceiveInfoName = (account: Account) =>
  account.username || account.id

const initializeCreatedAccount = async ({
  account,
  config,
  phone,
}: {
  account: Account
  config: AccountsConfig
  phone?: PhoneNumber
}): Promise<Account | ApplicationError> => {
  const newWallet = (currency: WalletCurrency) =>
    WalletsRepository().persistNew({
      accountId: account.id,
      type: WalletType.Checking,
      currency,
    })

  const walletsEnabledConfig = Array.from(
    new Set([...config.initialWallets, ...requiredCashWalletCurrencies]),
  )

  // Create all wallets
  const enabledWallets: Partial<Record<WalletCurrency, Wallet>> = {}
  for (const currency of walletsEnabledConfig) {
    const wallet = await newWallet(currency)
    if (wallet instanceof Error) {
      recordExceptionInCurrentSpan({
        error: wallet,
        level: ErrorLevel.Critical,
        attributes: { accountId: account.id, currency },
      })
      if (requiredCashWalletCurrencies.includes(currency)) return wallet
      continue
    }

    enabledWallets[currency] = wallet
  }

  // Set ETH-USDT as the active Cash Wallet while preserving USD for migration.
  const defaultWallet = enabledWallets[defaultCashWalletCurrency]
  const defaultWalletId = defaultWallet?.id

  if (defaultWalletId === undefined) {
    return new ConfigError("NoWalletsEnabledInConfigError")
  }
  account.defaultWalletId = defaultWalletId

  const defaultCashWalletReceiveOption = await Ibex.getEthereumUsdtOption()
  if (defaultCashWalletReceiveOption instanceof Error)
    return defaultCashWalletReceiveOption

  const receiveInfo = await Ibex.createCryptoReceiveInfo(defaultWalletId, {
    ...defaultCashWalletReceiveOption,
    name: defaultCashWalletReceiveInfoName(account),
  })
  if (receiveInfo instanceof Error) return receiveInfo
  account.bridgeEthereumAddress = receiveInfo.address

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
