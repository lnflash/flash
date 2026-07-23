import { PaymentSendStatus } from "@domain/bitcoin/lightning"
import { ValidationError } from "@domain/shared"

import { RepositoryError } from "@domain/errors"
import { AccountsRepository, WalletsRepository } from "@services/mongoose"
import Ibex from "@services/ibex/client"

import { notifyOpsEvent } from "@services/alerts/ops-events"
import ErpNext, { CashoutId } from "@services/frappe/ErpNext"
import { CashoutDraftError, CashoutSubmitError } from "@services/frappe/errors"
import { baseLogger } from "@services/logger"
import { IbexError } from "@services/ibex/errors"
import { Cashout } from "@config"

import { CashoutDetails, ValidationInputs } from "./types"
import { CashoutValidator } from "./Validator"
import Offer from "./Offer"

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

  private notifyStepFailed(step: string, error: Error): void {
    notifyOpsEvent({
      flow: "cashout",
      phase: "failed",
      status: "failed",
      accountId: this.account.id,
      step,
      error: error.constructor.name,
    })
  }

  async execute(): Promise<InitiatedCashout | Error> {
    const cashoutId = await ErpNext.draftCashout(this)
    if (cashoutId instanceof CashoutDraftError) {
      this.notifyStepFailed("draftCashout", cashoutId)
      return cashoutId
    }

    if (!Cashout.SkipPayment) {
      const resp = await Ibex.payInvoice({
        accountId: this.details.payment.userAcct,
        invoice: this.details.payment.invoice.paymentRequest as unknown as Bolt11,
      })
      if (resp instanceof IbexError) {
        baseLogger.error({ resp }, "Failed to pay invoice for cashout")
        this.notifyStepFailed("payInvoice", resp)
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
        baseLogger.error(
          { cashoutId },
          "submitCashout failed after retry — manual intervention required",
        )
        this.notifyStepFailed("submitCashout", submitted)
      }
    }
    const erpSubmitted = !(submitted instanceof CashoutSubmitError)

    return new InitiatedCashout(this, cashoutId, erpSubmitted)
  }
}

export default ValidOffer

export class InitiatedCashout {
  readonly status = PaymentSendStatus.Pending
  readonly offer: ValidOffer
  readonly cashoutId: CashoutId
  // False when the ERPNext submit failed after retry (payment made, manual
  // intervention pending). Informational for callers/ops — GraphQL output is
  // unchanged.
  readonly erpSubmitted: boolean

  constructor(offer: ValidOffer, cashoutId: CashoutId, erpSubmitted = true) {
    this.offer = offer
    this.cashoutId = cashoutId
    this.erpSubmitted = erpSubmitted
  }
}
