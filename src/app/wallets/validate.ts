import { WalletCurrency } from "@domain/shared"
import { MismatchedCurrencyForWalletError } from "@domain/errors"

import { WalletsRepository } from "@services/mongoose"

export const validateIsBtcWallet = async (
  walletId: WalletId,
): Promise<true | ApplicationError> => {
  const wallet = await WalletsRepository().findById(walletId)
  if (wallet instanceof Error) return wallet

  if (wallet.currency !== WalletCurrency.Btc) {
    return new MismatchedCurrencyForWalletError()
  }
  return true
}

export const validateIsUsdWallet = async (
  walletId: WalletId,
  args?: { includeUsdt?: boolean },
): Promise<true | ApplicationError> => {
  const wallet = await WalletsRepository().findById(walletId)
  if (wallet instanceof Error) return wallet

  const isAllowed =
    wallet.currency === WalletCurrency.Usd ||
    (args?.includeUsdt === true && wallet.currency === WalletCurrency.Usdt)

  if (!isAllowed) {
    return new MismatchedCurrencyForWalletError()
  }
  return true
}

export const validateIsUsdtWallet = async (
  walletId: WalletId,
): Promise<true | ApplicationError> => {
  const wallet = await WalletsRepository().findById(walletId)
  if (wallet instanceof Error) return wallet

  if (wallet.currency !== WalletCurrency.Usdt) {
    return new MismatchedCurrencyForWalletError()
  }
  return true
}
