import { getBalanceForWallet } from "@app/wallets";
import { Cashout } from "@config";
import { AccountValidator, hasErpParty, isActiveAccount, walletBelongsToAccount } from "@domain/accounts";
import { JMDAmount, USDAmount, ValidationError, ValidationFn, validator } from "@domain/shared";
import { ValidationInputs } from "./types";
import ErpNext from "@services/frappe/ErpNext";

const config = Cashout.validations

const isBeforeExpiry = async (o: ValidationInputs): Promise<true | ValidationError> => {
  const now = new Date()
  if (now > o.payment.invoice.expiresAt) return new ValidationError("Offer has expired")
  else return true
}

const cashoutMin = async (o: ValidationInputs): Promise<true | ValidationError> => {
  const min = USDAmount.cents(config.minimum.amount)
  if (min instanceof Error) return new ValidationError(min)
  if (o.payment.amount.isLesserThan(min))
    return new ValidationError(`Minimum cashout is $${min.asDollars()}`)
  else return true
}

const cashoutMax: ValidationFn<ValidationInputs> = async (o: ValidationInputs): Promise<true | ValidationError> => {
  const max = USDAmount.cents(config.maximum.amount)
  if (max instanceof Error) return new ValidationError(max)
  if (o.payment.amount.isGreaterThan(max))
    return new ValidationError(`Maximum cashout is $${max.asDollars()}`)
  else return true
}

const isUsd = async (o: ValidationInputs) => {
  if (o.wallet.currency !== "USD")
    return new ValidationError("Cash out only supports withdrawals from USD wallets")
  return true
}

const hasSufficientBalance = async (o: ValidationInputs): Promise<true | ValidationError> => {
  const balance = await getBalanceForWallet({ walletId: o.wallet.id })
  if (balance instanceof Error)
    return new ValidationError(balance)
  else if (o.payment.amount.isGreaterThan(balance))
    return new ValidationError("Transfer amount is greater than wallet balance.")
  else return true
}

const accountLevel = async (o: ValidationInputs) => {
  return AccountValidator(o.account).isLevel(config.accountLevel)
}

// Much of this logic is checked server-side in erpnext, but we want to catch it as early as possible 
const verifyBankAccount = async (o: ValidationInputs): Promise<true | ValidationError> => {
  const erpParty = o.account.erpParty
  if (!erpParty) return new ValidationError("Account does not have an associated erpParty")
  const banks = await ErpNext.getBankAccountsByCustomer(erpParty)
  if (banks instanceof Error) return new ValidationError("Could not confirm bank account for user")
  const bankAccount = banks.find(b => b.name === o.payout.bankAccountId)
  if (!bankAccount) return new ValidationError("Bank account does not belong to user")
  const payoutCurrency = o.payout.amount instanceof JMDAmount ? "JMD" : "USD"
  if (bankAccount.currency !== payoutCurrency)
    return new ValidationError(`Bank account currency (${bankAccount.currency}) does not match payout currency (${payoutCurrency})`)
  return true
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
  verifyBankAccount,
  //  TODO daily/weekly/monthly volume limits
])