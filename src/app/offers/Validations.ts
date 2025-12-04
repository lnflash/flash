import { getBalanceForWallet } from "@app/wallets";
import { Cashout } from "@config";
import { AccountValidator } from "@domain/accounts";
import { USDAmount, ValidationError } from "@domain/shared";
import { ValidationFn, ValidationInputs } from "./types";

const config = Cashout.validations

export const isBeforeExpiry = async (o: ValidationInputs): Promise<true | ValidationError> => {
  const now = new Date()
  if (now > o.ibexTrx.invoice.expiresAt) return new ValidationError("Offer has expired")
  else return true
}

export const transferMin = async (o: ValidationInputs): Promise<true | ValidationError> => {
  const min = USDAmount.cents(config.minimum.amount)
  if (min instanceof Error) return new ValidationError(min)
  if (o.ibexTrx.usd.isLesserThan(min)) 
    return new ValidationError(`Minimum cashout is $${min.asDollars()}`)
  else return true 
}

export const transferMax = async (o: ValidationInputs): Promise<true | ValidationError> => {
  const max = USDAmount.cents(config.maximum.amount)
  if (max instanceof Error) return new ValidationError(max)
  if (o.ibexTrx.usd.isGreaterThan(max) ) 
    return new ValidationError(`Maximum cashout is $${max.asDollars()}`)
  else return true 
}

export const isUsd = async (o: ValidationInputs) => {
  // if (o.ibexTrx.currency !== "USD") 
  //   return new ValidationError("Cash out only supports USD")
  if (o.wallet.currency !== "USD") 
    return new ValidationError("Cash out only supports withdrawals from USD wallets")
  return true
}

export const hasSufficientBalance = async (o: ValidationInputs): Promise<true | ValidationError> => {
  const balance = await getBalanceForWallet({ walletId: o.wallet.id })
  if (balance instanceof Error) 
    return new ValidationError(balance) 
  else if (o.ibexTrx.usd.isGreaterThan(balance)) 
    return new ValidationError("Transfer amount is greater than wallet balance.")
  else return true
}

export const isActiveAccount = async (o: ValidationInputs) => {
  return AccountValidator(o.account).isActive()
}

export const accountLevel = async (o: ValidationInputs) => {
  return AccountValidator(o.account).isLevel(config.accountLevel)
}

export const walletBelongsToAccount = async (o: ValidationInputs) => {
  return AccountValidator(o.account).validateWalletForAccount(o.wallet)
}

// TODO: Look this field up against ERP system to ensure it is valid
export const hasErpParty = async (o: ValidationInputs): Promise<true | ValidationError> => {
  if (!o.account.erpParty) {
    return new ValidationError("Account is missing erpParty field.")
  }
  return true
}

export const validate = async (inputs: ValidationInputs, validators: ValidationFn[]): Promise<ValidationError[]> => {
  const results = await Promise.all(validators.map(v => v(inputs)))
  return results.filter((r): r is ValidationError => (r !== true)) 
};