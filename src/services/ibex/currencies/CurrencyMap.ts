// See https://docs.ibexmercado.com/reference/get-all for Ibex currencies
import { UnsupportedCurrencyError } from "@domain/errors"
import { WalletCurrency } from "@domain/shared"
import USDollars from "./USDollars";

const supportedCurrencies = new Map<WalletCurrency, IbexCurrencyId>([
  [WalletCurrency.Usd, USDollars.currencyId]
]);

const CurrencyMap = {
  getCurrencyId: (c: WalletCurrency): IbexCurrencyId | UnsupportedCurrencyError => {
    return supportedCurrencies.get(c) || new UnsupportedCurrencyError(`Cannot create wallet for currency ${c}`)
  }
}

export default CurrencyMap