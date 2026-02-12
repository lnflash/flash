import { ValidationError } from "./errors";
import { WalletCurrency } from "./primitives";


export const UuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// Note: do not export. This symbol should only be used to create Validated<T> in this module
const validatedSymbol = Symbol("validated")

export type Validated<T> = T & { [validatedSymbol]: true }

export const isValidated = <T>(value: T | Validated<T> | ValidationError[]): value is Validated<T> => {
  return !Array.isArray(value) && typeof value === 'object' && value !== null && validatedSymbol in value
}

export type ValidationFn<T> = (inputs: T) => Promise<true | ValidationError>;

export const validator = <T>(validators: ValidationFn<T>[]) =>
  async (inputs: T): Promise<Validated<T> | ValidationError[]> => {
    const results = await Promise.all(validators.map(v => v(inputs)))
    const errs = results.filter((r): r is ValidationError => (r !== true))
    if (errs.length > 0) return errs
    else return { ...inputs, [validatedSymbol]: true } as Validated<T>
};

const checkWalletCurrency = (currency: WalletCurrency) => async (o: { wallet: Wallet }) => {
  if (o.wallet.currency === currency) {
    return true
  }
  return new ValidationError(`Expected ${currency}, got ${o.wallet.currency}`)
}

export const isBtcWallet = checkWalletCurrency(WalletCurrency.Btc)
export const isUsdWallet = checkWalletCurrency(WalletCurrency.Usd)
