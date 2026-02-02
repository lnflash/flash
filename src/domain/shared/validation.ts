import { AccountValidator } from "@domain/accounts";
import { ValidationError } from "./errors";
import { WalletCurrency } from "./primitives";
import { MismatchedCurrencyForWalletError } from "@domain/errors";


export const UuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// Note: do not export. This symbol should only be used to create Validated<T> in this module
const validatedSymbol = Symbol("validated")
                                                                                                                                                                                                                                             
export type Validated<T> = T & { [validatedSymbol]: true } 

export type ValidationFn<T> = (inputs: T) => Promise<true | ValidationError>;

export const validator = <T>(validators: ValidationFn<T>[]) => 
  async (inputs: T): Promise<Validated<T> | ValidationError[]> => {
    const results = await Promise.all(validators.map(v => v(inputs)))
    const errs = results.filter((r): r is ValidationError => (r !== true)) 
    if (errs.length > 0) return errs
    else return { ...inputs, [validatedSymbol]: true } as Validated<T>
};

export const isActiveAccount = async (o: { account: Account }) => {
  return AccountValidator(o.account).isActive()
}

// TODO: Look this field up against ERP system to ensure it is valid
export const hasErpParty = async (o: { account: Account }): Promise<true | ValidationError> => {
  if (!o.account.erpParty) {
    return new ValidationError("Account is missing erpParty field.")
  }
  return true
}

export const walletBelongsToAccount = async (o: { account: Account, wallet: Wallet}) => {
  return AccountValidator(o.account).validateWalletForAccount(o.wallet)
}

const checkWalletCurrency = (currency: WalletCurrency) => async (o: { wallet: Wallet }) => {
  if (o.wallet.currency === currency) {
    return true
  }
  return new MismatchedCurrencyForWalletError(`Expected ${currency}, got ${o.wallet.currency}`)
}

export const isBtcWallet = checkWalletCurrency(WalletCurrency.Btc)
export const isUsdWallet = checkWalletCurrency(WalletCurrency.Usd)
