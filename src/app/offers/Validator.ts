import { getBalanceForWallet } from "@app/wallets";
import { Cashout } from "@config";
import { AccountValidator, hasErpParty, isActiveAccount, walletBelongsToAccount } from "@domain/accounts";
import { USDAmount, ValidationError, ValidationFn, validator } from "@domain/shared";
import { ValidationInputs } from "./types";

const config = Cashout.validations

const isBeforeExpiry = async (o: ValidationInputs): Promise<true | ValidationError> => {
  const now = new Date()
  if (now > o.ibexTrx.invoice.expiresAt) return new ValidationError("Offer has expired")
  else return true
}

const cashoutMin = async (o: ValidationInputs): Promise<true | ValidationError> => {
  const min = USDAmount.cents(config.minimum.amount)
  if (min instanceof Error) return new ValidationError(min)
  if (o.ibexTrx.usd.isLesserThan(min)) 
    return new ValidationError(`Minimum cashout is $${min.asDollars()}`)
  else return true 
}

const cashoutMax: ValidationFn<ValidationInputs> = async (o: ValidationInputs): Promise<true | ValidationError> => {
  const max = USDAmount.cents(config.maximum.amount)
  if (max instanceof Error) return new ValidationError(max)
  if (o.ibexTrx.usd.isGreaterThan(max) ) 
    return new ValidationError(`Maximum cashout is $${max.asDollars()}`)
  else return true 
} 

const isUsd = async (o: ValidationInputs) => {
  // if (o.ibexTrx.currency !== "USD") 
  //   return new ValidationError("Cash out only supports USD")
  if (o.wallet.currency !== "USD") 
    return new ValidationError("Cash out only supports withdrawals from USD wallets")
  return true
}

const hasSufficientBalance = async (o: ValidationInputs): Promise<true | ValidationError> => {
  const balance = await getBalanceForWallet({ walletId: o.wallet.id })
  if (balance instanceof Error) 
    return new ValidationError(balance) 
  else if (o.ibexTrx.usd.isGreaterThan(balance)) 
    return new ValidationError("Transfer amount is greater than wallet balance.")
  else return true
}


const accountLevel = async (o: ValidationInputs) => {
  return AccountValidator(o.account).isLevel(config.accountLevel)
}


export const CashoutValidator = validator([
  isUsd,
  cashoutMin,
  cashoutMax,
  isActiveAccount,
  accountLevel,
  walletBelongsToAccount,
  hasSufficientBalance,
  isBeforeExpiry,
  hasErpParty,
  //  TODO daily/weekly/monthly volume limits
])