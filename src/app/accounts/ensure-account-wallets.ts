import { CouldNotFindError } from "@domain/errors"
import { ErrorLevel, WalletCurrency } from "@domain/shared"
import { WalletType } from "@domain/wallets"

import { AccountsRepository, WalletsRepository } from "@services/mongoose"
import { recordExceptionInCurrentSpan } from "@services/tracing"

export const requiredCashWalletCurrencies: WalletCurrency[] = [
  WalletCurrency.Usd,
  WalletCurrency.Usdt,
]

export const defaultCashWalletCurrency = WalletCurrency.Usdt

// Every cash wallet is an IBEX account, and `createAccount` fails
// transiently — a rolling deploy, a timed-out first call. The account row is
// already committed by then, so bailing out leaves an account with no wallets
// and no `defaultWalletId`, and the next login finds that account and never
// retries it. Reading what exists and creating only what is missing makes the
// second attempt finish the job instead of repeating the failure.
export const createMissingCashWallets = async ({
  accountId,
  currencies,
  existingWallets,
}: {
  accountId: AccountId
  currencies: WalletCurrency[]
  existingWallets: Wallet[]
}): Promise<Partial<Record<WalletCurrency, Wallet>> | ApplicationError> => {
  const wallets = WalletsRepository()

  const enabledWallets: Partial<Record<WalletCurrency, Wallet>> = {}

  for (const currency of Array.from(
    new Set([...currencies, ...requiredCashWalletCurrencies]),
  )) {
    const existing = existingWallets.find(
      (wallet) => wallet.currency === currency && wallet.type === WalletType.Checking,
    )
    if (existing) {
      enabledWallets[currency] = existing
      continue
    }

    const wallet = await wallets.persistNew({
      accountId,
      type: WalletType.Checking,
      currency,
    })
    if (wallet instanceof Error) {
      recordExceptionInCurrentSpan({
        error: wallet,
        level: ErrorLevel.Critical,
        attributes: { accountId, currency },
      })
      if (requiredCashWalletCurrencies.includes(currency)) return wallet
      continue
    }

    enabledWallets[currency] = wallet
  }

  return enabledWallets
}

// An account row is committed before its wallets exist, so a half-initialised
// account is identifiable by the missing `defaultWalletId`. That is the signal
// the read path uses to come back and finish the job once IBEX answers again —
// without it the first failure is permanent for that user.
export const ensureCashWallets = async (
  account: Account,
  currencies: WalletCurrency[] = requiredCashWalletCurrencies,
): Promise<Account | ApplicationError> => {
  const existingWallets = await WalletsRepository().listByAccountId(account.id)
  if (existingWallets instanceof Error) return existingWallets

  const enabledWallets = await createMissingCashWallets({
    accountId: account.id,
    currencies: [...currencies, ...existingWallets.map((wallet) => wallet.currency)],
    existingWallets,
  })
  if (enabledWallets instanceof Error) return enabledWallets

  const defaultWalletId = enabledWallets[defaultCashWalletCurrency]?.id
  if (defaultWalletId === undefined) {
    return new CouldNotFindError("No cash wallet could be enabled for the account")
  }

  if (account.defaultWalletId === defaultWalletId) return account

  const updatedAccount = await AccountsRepository().update({
    ...account,
    defaultWalletId,
  })
  if (updatedAccount instanceof Error) return updatedAccount

  return updatedAccount
}
