import { LedgerService } from "@services/ledger"
import Offer from "./Offer"
import { PaymentSendStatus } from "@domain/bitcoin/lightning"
import { LedgerServiceError } from "@domain/ledger"
import { ValidationError } from "@domain/shared"
import { accountLevel, isActiveAccount, isUsd, hasSufficientBalance, transferMin, validate, walletBelongsToAccount, transferMax, isBeforeExpiry } from "./Validations"
// import { sendBetweenAccounts } from "@services/ibex/send-between-accounts"
import { RepositoryError } from "@domain/errors"
import { AccountsRepository, WalletsRepository } from "@services/mongoose"
import Ibex from "@services/ibex/client"
import { EmailService } from "@services/email"
import { CashoutDetails, ValidationInputs } from "./types"

// Only way to construct a ValidOffer is using the static method which contains validations  
class ValidOffer extends Offer {
  readonly wallet: Wallet
  readonly account: Account

  private constructor(o: ValidationInputs) {
    const { wallet, account, ...details } = o
    super(details)
    this.wallet = wallet
    this.account = account
  }

  static from = async (details: CashoutDetails): Promise<ValidOffer | ValidationError> => {
    const wallet = await WalletsRepository().findById(details.ibexTrx.userAcct)
    if (wallet instanceof RepositoryError) return new ValidationError(wallet)
    
    const account = await AccountsRepository().findById(wallet.accountId)
    if (account instanceof RepositoryError) return new ValidationError(account)

    const inputs: ValidationInputs = { ...details, wallet, account }
    const validationErrs = await validate(inputs, [
      isUsd, 
      transferMin,
      transferMax,
      isActiveAccount,
      accountLevel,
      walletBelongsToAccount,
      hasSufficientBalance,
      isBeforeExpiry,
    //  TODO daily/weekly/monthly volume limits 
    ])
    if (validationErrs.length > 0) return new ValidationError(validationErrs)

    return new ValidOffer(inputs)
  }

  async execute(): Promise<PaymentSendStatus | Error> {
    const resp = await Ibex.payInvoice({
      accountId: this.details.ibexTrx.userAcct, 
      invoice: this.details.ibexTrx.invoice.paymentRequest as unknown as Bolt11
    })
    if (resp instanceof Error) return resp 

    // balance the diff
    // const ibexResp = await sendBetweenAccounts(
    //   IbexAccount.fromWallet(this.wallet), 
    //   flashWallet,
    //   this.details.ibexTransfer,
    //   "Withdraw to bank",
    // ) 
    // if (ibexResp instanceof Error) return ibexResp 

    const ledgerResp = await LedgerService().recordCashOut(this.details)
    if (ledgerResp instanceof LedgerServiceError) {
      return ledgerResp // TODO: change to a log
    }

    // move to NotificationService?
    EmailService.sendCashoutInitiatedEmail(this.account.username, this.details)

    return PaymentSendStatus.Pending // awaiting rtgs transfer
  }
}

export default ValidOffer