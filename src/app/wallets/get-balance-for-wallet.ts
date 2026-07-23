import { UnknownLedgerError } from "@domain/ledger"
import { USDAmount, USDTAmount, WalletCurrency } from "@domain/shared"
import Ibex from "@services/ibex/client"
import { IbexError } from "@services/ibex/errors"

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
    if (resp.balance === undefined) {
      // IBEX omits `balance` for drained / never-funded accounts (per-account and
      // bulk endpoints alike: absent means zero — verified in prod during the USDT
      // cutover). Post-cutover, every migrated account's legacy USD wallet reads
      // this way; returning an error here broke the admin API's wallets[].balance
      // for all migrated accounts (the cash-wallet compat redirect only runs when
      // client capabilities are in ctx, i.e. for app users — never for admin).
      return currency === WalletCurrency.Usdt ? USDTAmount.ZERO : USDAmount.ZERO
    }
    return resp.balance
  } catch (err) {
    return new UnknownLedgerError(err)
  }
}
