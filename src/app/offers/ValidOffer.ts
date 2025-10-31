import { LedgerService } from "@services/ledger"
import Offer from "./Offer"
import { PaymentSendStatus } from "@domain/bitcoin/lightning"
import { LedgerServiceError } from "@domain/ledger"
import { ValidationError } from "@domain/shared"
import {
  accountLevel,
  isActiveAccount,
  isUsd,
  hasSufficientBalance,
  transferMin,
  validate,
  walletBelongsToAccount,
  transferMax,
  isBeforeExpiry,
  hasErpParty,
} from "./Validations"
import { RepositoryError } from "@domain/errors"
import { AccountsRepository, WalletsRepository } from "@services/mongoose"
import Ibex from "@services/ibex/client"
import { EmailService } from "@services/email"
import { CashoutDetails, ValidationInputs } from "./types"
import ErpNext from "@services/frappe/ErpNext"
import { JournalEntryDraftError, JournalEntrySubmitError } from "@services/frappe/errors"
import { baseLogger } from "@services/logger"
import { IbexError } from "@services/ibex/errors"

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
      hasErpParty,
      //  TODO daily/weekly/monthly volume limits
    ])
    if (validationErrs.length > 0) return new ValidationError(validationErrs)

    return new ValidOffer(inputs)
  }

  async execute(): Promise<InitiatedCashout | Error> {
    const journal = await ErpNext.draftCashout(this)
    if (journal instanceof JournalEntryDraftError) return journal
    const id = journal.journalId

    const resp = await Ibex.payInvoice({
      accountId: this.details.ibexTrx.userAcct,
      invoice: this.details.ibexTrx.invoice.paymentRequest as unknown as Bolt11,
    })
    if (resp instanceof IbexError) {
      ErpNext.delete(id) // clean up accounting entry
      return resp
    }

    const submitted = await ErpNext.submit(id)
    if (submitted instanceof JournalEntrySubmitError) {
      baseLogger.error({ submitted }, "Failed to submit journal after payment sent")
    }

    return new InitiatedCashout(this, id) 
  }
}

export default ValidOffer



export class InitiatedCashout {
  readonly status = PaymentSendStatus.Pending
  constructor(readonly offer: ValidOffer, readonly journalId: LedgerJournalId) {}
}
