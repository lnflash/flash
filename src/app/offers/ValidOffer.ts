import { intraledgerPaymentSendWalletIdForUsdWallet } from "../payments/send-intraledger"
import { LedgerService } from "@services/ledger"
import { getBankOwnerWalletId } from "@services/ledger/caching"
import Offer from "./Offer"
import { PaymentSendStatus } from "@domain/bitcoin/lightning"
import PersistedOffer from "./db/PersistedOffer"
import OffersRepository from "./db/OffersRepository"
import { LedgerServiceError } from "@domain/ledger"

import { RepositoryError } from "@domain/errors"

import { AccountsRepository, WalletsRepository } from "@services/mongoose"
import { AccountValidator } from "@domain/accounts"
import { ValidationError } from "@domain/shared"
import { getBalanceForWallet } from "@app/wallets"

// import { offerConfig as config } from "@config"
const config: ValidationConfig = {
    minimum: {
      amount: 0n, // 1000n, // $10
      currency: "USD"
    },
    accountLevel: 2
}

class ValidOffer extends Offer {
  // Only way to construct a ValidOffer is using the validate function  
  private constructor(o: CashoutDetails) {
    super(o)
  }

  //  TODO Volume limits - withdrawal limit. 
  static from = async (details: CashoutDetails): Promise<ValidOffer | ApplicationError> => {
    const { walletId, ibexTransfer } = details

    if (ibexTransfer.amount < config.minimum.amount)
      return new ValidationError(`Minimum cashout is ${config.minimum.amount}`) 

    const wallet = await WalletsRepository().findById(walletId)
    if (wallet instanceof RepositoryError) return wallet
    
    if (wallet.currency !== "USD") 
      return new ValidationError("Cash out only supports withdrawals from USD wallets")
  
    const balance = await getBalanceForWallet({ walletId })
    if (balance instanceof Error) {
      // TODO log error instead of failing
      return balance
    }
    if (ibexTransfer.amount > balance.valueOf()) {
      return new ValidationError("Transfer amount is greater than user balance.")
    }

    const account = await AccountsRepository().findById(wallet.accountId)
    if (account instanceof RepositoryError) return account
  
    const accountValidator = AccountValidator(account)
    if (accountValidator instanceof ValidationError) 
      return accountValidator

    const validWallet = accountValidator.validateWalletForAccount(wallet)
    if (validWallet instanceof ValidationError) 
      return validWallet

    // TODO - Check
    // const validLevel = accountValidator.isLevel(2)
    // if (validLevel instanceof ValidationError) 
    //   return validLevel

    return new ValidOffer(details)
  }

  async persist(): Promise<PersistedOffer | RepositoryError> {
    return OffersRepository.upsert(this)
  }

  async execute(): Promise<PaymentSendStatus | Error> {
    const { walletId, ibexTransfer } = this.details
    const flashWalletId = await getBankOwnerWalletId()

    const ibexResp = await intraledgerPaymentSendWalletIdForUsdWallet({
      senderWalletId: walletId, 
      recipientWalletId: flashWalletId,
      amount: Number(ibexTransfer),
      memo: "Cash Out",
    }) 
    if (ibexResp instanceof Error) return ibexResp 

    const res = await LedgerService().recordCashOut(this.details)
    if (res instanceof LedgerServiceError) {
      return res // TODO: change to a log
    }

    // TODO: trigger notification to Flash support

    return PaymentSendStatus.Pending // awaiting rtgs transfer
  }
}

export default ValidOffer