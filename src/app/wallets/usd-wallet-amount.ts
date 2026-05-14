import { UnsupportedCurrencyError } from "@domain/errors"
import { USDAmount, USDTAmount, WalletCurrency } from "@domain/shared"

import { WalletsRepository } from "@services/mongoose"

export type UsdWalletAmount = USDAmount | USDTAmount

export const usdWalletAmountFromInput = (
  amount: string | number,
  currency: WalletCurrency,
): UsdWalletAmount | ApplicationError => {
  const raw = amount.toString()

  if (currency === WalletCurrency.Usd) return USDAmount.cents(raw)
  if (currency === WalletCurrency.Usdt) return USDTAmount.smallestUnits(raw)

  return new UnsupportedCurrencyError(`USD wallet amount unsupported for ${currency}`)
}

export const usdWalletAmountFromWalletId = async ({
  walletId,
  amount,
}: {
  walletId: WalletId
  amount: string | number
}): Promise<UsdWalletAmount | ApplicationError> => {
  const wallet = await WalletsRepository().findById(walletId)
  if (wallet instanceof Error) return wallet

  return usdWalletAmountFromInput(amount, wallet.currency)
}
