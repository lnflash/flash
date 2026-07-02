import { UnknownLedgerError } from "@domain/ledger"
import { USDAmount, USDTAmount, WalletCurrency } from "@domain/shared"
import Ibex from "@services/ibex/client"
import { IbexError, UnexpectedIbexResponse } from "@services/ibex/errors"

export const getBalanceForWallet = async ({
  walletId,
  currency,
}: {
  walletId: WalletId
  currency?: WalletCurrency
}): Promise<USDAmount | USDTAmount | ApplicationError> => {
  try {
    const resp = await Ibex.getAccountDetails(walletId, currency)
    if (resp instanceof IbexError) {
      if (resp.httpCode === 404) {
        return currency === WalletCurrency.Usdt ? USDTAmount.ZERO : USDAmount.ZERO
      }
      return resp
    }
    if (resp.balance === undefined) return new UnexpectedIbexResponse("Balance not found")
    return resp.balance
  } catch (err) {
    return new UnknownLedgerError(err)
  }
}
