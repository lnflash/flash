import { UnknownLedgerError } from "@domain/ledger"
import { BtcPaymentAmount, USDAmount, USDTAmount, WalletCurrency } from "@domain/shared"
import { LedgerService } from "@services/ledger"
import { isIbexAvailable } from "@services/ibex/availability"
import Ibex from "@services/ibex/client"
import { IbexError, IbexUnavailableError } from "@services/ibex/errors"

export const getBalanceForWallet = async ({
  walletId,
  currency,
}: {
  walletId: WalletId
  currency?: WalletCurrency
}): Promise<USDAmount | USDTAmount | ApplicationError> => {
  // While the IBEX circuit is open (see @services/ibex/availability) a BTC
  // wallet is still fully readable from the mongo ledger — the same path
  // `get-on-chain-fee` and the by-address history use — so the wallet screen
  // keeps showing real numbers through an IBEX blip instead of failing one
  // field per request, each paying its own fetch timeout. Cash balances are
  // authoritative only at IBEX, so those report unavailable rather than a
  // possibly stale ledger figure; the wallet resolvers turn that into a null
  // balance rather than an error.
  if (!isIbexAvailable()) {
    if (currency === WalletCurrency.Btc) return ledgerBalanceForWallet(walletId)
    return new IbexUnavailableError(new Error("IBEX is not responding"))
  }

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

// The ledger holds a BTC wallet's balance in sats, while every caller of this
// function is served cents (the IBEX path above converts IBEX's dollar figure
// with `USDAmount.dollars`). Converting at the mid price keeps the degraded
// read in the same unit as the healthy one, so a wallet screen does not jump
// between sats and cents as the circuit opens and closes.
const ledgerBalanceForWallet = async (
  walletId: WalletId,
): Promise<USDAmount | USDTAmount | ApplicationError> => {
  const balance = await LedgerService().getWalletBalance(walletId)
  if (balance instanceof Error) return balance

  // Loaded lazily so importing this module does not pull the price stack
  // (which reads dealer config at module scope) into every caller's graph.
  const { usdFromBtcMidPriceFn } = await import("@app/prices/mid-price")

  const usdBalance = await usdFromBtcMidPriceFn(BtcPaymentAmount(BigInt(balance)))
  if (usdBalance instanceof Error) return usdBalance

  return USDAmount.cents(String(usdBalance.amount))
}
