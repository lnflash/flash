import Offer from "./Offer"
import { PaymentSendStatus } from "@domain/bitcoin/lightning"
import { ValidationError } from "@domain/shared"
import { CashoutValidator } from "./Validator"
import { RepositoryError } from "@domain/errors"
import { AccountsRepository, WalletsRepository } from "@services/mongoose"
import Ibex from "@services/ibex/client"
import { CashoutDetails, ValidationInputs } from "./types"
import ErpNext, { CashoutId } from "@services/frappe/ErpNext"
import { JournalEntryDraftError, CashoutSubmitError } from "@services/frappe/errors"
import { baseLogger } from "@services/logger"
import { IbexError } from "@services/ibex/errors"
import { Cashout } from "@config"

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

  static from = async (
    details: CashoutDetails,
  ): Promise<ValidOffer | ValidationError> => {
    const wallet = await WalletsRepository().findById(details.payment.userAcct)
    if (wallet instanceof RepositoryError) return new ValidationError(wallet)

    const account = await AccountsRepository().findById(wallet.accountId)
    if (account instanceof RepositoryError) return new ValidationError(account)

    const inputs: ValidationInputs = { ...details, wallet, account }
    const validation = await CashoutValidator(inputs)

    if (Array.isArray(validation)) return new ValidationError(validation)

    return new ValidOffer(validation)
  }

  async execute(): Promise<InitiatedCashout | Error> {
    const cashoutId = await ErpNext.draftCashout(this)
    if (cashoutId instanceof JournalEntryDraftError) return cashoutId

    if (!Cashout.SkipPayment) {
      const resp = await Ibex.payInvoice({
        accountId: this.details.payment.userAcct,
        invoice: this.details.payment.invoice.paymentRequest as unknown as Bolt11,
      })
      if (resp instanceof IbexError) {
        baseLogger.error({ resp }, "Failed to pay invoice for cashout")
        return resp
      }
    } else {
      baseLogger.warn({ cashoutId }, "Skipping Ibex payment (skipPayment=true)")
    }

    let submitted = await ErpNext.submitCashout(cashoutId)
    if (submitted instanceof CashoutSubmitError) {
      baseLogger.warn({ cashoutId }, "submitCashout failed, retrying")
      submitted = await ErpNext.submitCashout(cashoutId)
      if (submitted instanceof CashoutSubmitError) {
        baseLogger.error({ cashoutId }, "submitCashout failed after retry — manual intervention required")
      }
    }

    return new InitiatedCashout(this, cashoutId)
  }
}

export default ValidOffer



export class InitiatedCashout {
  readonly status = PaymentSendStatus.Pending
  constructor(readonly offer: ValidOffer, readonly cashoutId: CashoutId) {}
}
