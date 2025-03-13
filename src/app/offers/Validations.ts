import { getBalanceForWallet } from "@app/wallets";
import { AccountLevel, AccountValidator } from "@domain/accounts";
import { ValidationError } from "@domain/shared";

const config: ValidationConfig = {
    minimum: {
      amount: 0n, // 1000n, // $10
      currency: "USD"
    },
    maximum: {
      amount: 10000000n, // get from Bitcoin withdrawal limit
      currency: "USD"
    },
    accountLevel: AccountLevel.Two
}

export const isBeforeExpiry = async (o: ValidationInputs): Promise<true | ValidationError> => {
  const now = new Date()
  if (now > o.ibexTrx.invoice.expiresAt) return new ValidationError("Offer has expired")
  else return true
}

export const transferMin = async (o: ValidationInputs): Promise<true | ValidationError> => {
  if (o.ibexTrx.usdAmount.amount < config.minimum.amount) 
    return new ValidationError(`Minimum cashout is ${config.minimum.amount}`)
  else return true 
}

export const transferMax = async (o: ValidationInputs): Promise<true | ValidationError> => {
  if (o.ibexTrx.usdAmount.amount > config.maximum.amount) 
    return new ValidationError(`Maximum cashout is ${config.maximum.amount}`)
  else return true 
}

export const isUsd = async (o: ValidationInputs) => {
  if (o.ibexTrx.currency !== "USD") 
    return new ValidationError("Cash out only supports USD")
  if (o.wallet.currency !== "USD") 
    return new ValidationError("Cash out only supports withdrawals from USD wallets")
  return true
}

export const hasSufficientBalance = async (o: ValidationInputs): Promise<true | ValidationError> => {
  const balance = await getBalanceForWallet({ walletId: o.wallet.id })
  if (balance instanceof Error) 
    return new ValidationError(balance) 
  else if (o.ibexTrx.usdAmount.amount > balance.valueOf()) 
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

export const validate = async (inputs: ValidationInputs, validators: ValidationFn[]): Promise<ValidationError[]> => {
  const results = await Promise.all(validators.map(v => v(inputs)))
  return results.filter((r): r is ValidationError => (r !== true)) 
};