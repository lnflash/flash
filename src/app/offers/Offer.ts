import { AccountsRepository, WalletsRepository } from "@services/mongoose"
import { AccountValidator } from "@domain/accounts"
import { ValidationError } from "@domain/shared"
import { RepositoryError } from "@domain/errors"
import ValidOffer from "./ValidOffer"
import { getBalanceForWallet } from "@app/wallets"

export type CashoutDetails  = {
  walletId: WalletId,
  ibexTransfer: Amount<"USD">
  usdLiability: Amount<"USD">
  jmdLiability: Amount<"JMD">
  exchangeRate: number 
  flashFee: Amount<"USD">
  createdAt: Date
  expiresAt: Date
}

class Offer {
  readonly details: CashoutDetails

  constructor(details: CashoutDetails) {
    this.details = details
  }

  //  TODO Volume limits - withdrawal limit. 
  validate = async (): Promise<ValidOffer | Error> => {
    const { walletId } = this.details

    const wallet = await WalletsRepository().findById(walletId)
    if (wallet instanceof RepositoryError) return wallet
   
    const balance = await getBalanceForWallet({ walletId })
    if (balance instanceof Error) {
      // TODO log error instead of failing
      return balance
    }

    if (wallet.currency !== "USD") 
      return new ValidationError("Cash out only supports withdrawals from USD wallets")

    const account = await AccountsRepository().findById(wallet.accountId)
    if (account instanceof RepositoryError) return account
  
    const accountValidator = AccountValidator(account)
    if (accountValidator instanceof ValidationError) 
      return accountValidator

    const validateWallet = accountValidator.validateWalletForAccount(wallet)
    if (validateWallet instanceof ValidationError) 
      return validateWallet

    return new ValidOffer(this)
  }
}

export default Offer