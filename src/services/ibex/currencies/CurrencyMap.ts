// See https://docs.ibexmercado.com/reference/get-all for Ibex currencies
import { UnsupportedCurrencyError } from "@domain/errors"
import { WalletCurrency } from "@domain/shared"
import USDollars from "./USDollars";
import MSats from "./MSats";

const supportedCurrencies = new Map<WalletCurrency, IbexCurrencyId>([
  [WalletCurrency.Usd, USDollars.currencyId]
]);

const CurrencyMap = {
  getCurrencyId: (c: WalletCurrency): IbexCurrencyId | UnsupportedCurrencyError => {
    return supportedCurrencies.get(c) || new UnsupportedCurrencyError(`Cannot create wallet for currency ${c}`)
  },

  toIbexCurrency: (amount: number, currencyId: number): IbexCurrency => {
    switch (currencyId) {
      case USDollars.currencyId:
        return USDollars.fromIbex(amount)
      case MSats.currencyId:
        return MSats.fromIbex(amount)
      default:
        throw new UnsupportedCurrencyError(`Cannot create currency for currencyId ${currencyId}`)
    }
  },
}

export default CurrencyMap