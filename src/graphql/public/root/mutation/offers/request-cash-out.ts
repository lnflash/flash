import OffersManager from "@app/offers/OffersManager"
import { mapToGqlErrorList } from "@graphql/error-map"
import { GT } from "@graphql/index"
import CashoutOffer from "@graphql/public/types/object/cashout-offer"
import IError from "@graphql/shared/types/abstract/error"
import USDCentsScalar from "@graphql/shared/types/scalar/usd-cents"
import WalletId from "@graphql/shared/types/scalar/wallet-id"
import dedent from "dedent"
import { Cashout } from "@config"
import { NotImplementedError, RepositoryError } from "@domain/errors"
import ErpNext from "@services/frappe/ErpNext"
import { AccountsRepository, WalletsRepository } from "@services/mongoose"
import { ValidationError } from "@domain/shared"

const RequestCashoutInput = GT.Input({
  name: "RequestCashoutInput",
  fields: () => ({
    walletId: {
      type: GT.NonNull(WalletId),
      description: "ID for a USD wallet belonging to the current user.",
    },
    amount: {
      type: GT.NonNull(USDCentsScalar), 
      description: "Amount in USD cents." 
    },
  }),
})

const RequestCashoutResponse = GT.Object({
  name: "RequestCashoutResponse",
  fields: () => ({
    errors: {
      type: GT.NonNullList(IError),
    },
    offer: {
      type: CashoutOffer,
    },
  }),
})

const RequestCashoutMutation = GT.Field({
  description: dedent`Returns an offer from Flash for a user to withdraw from their USD wallet (denominated in cents).
  The user can review this offer and then execute the withdrawal by calling the initiateCashout mutation.`,
  args: {
    input: { type: GT.NonNull(RequestCashoutInput) },
  },
  type: GT.NonNull(RequestCashoutResponse),
  extensions: {
    complexity: 120,
  },
  resolve: async (_, args) => {
    if (!Cashout.Enabled)
      return new NotImplementedError("Cashout feature is not enabled")

    const { walletId, amount } = args.input
    for (const input of [walletId, amount]) {
      if (input instanceof Error) {
        return { errors: [{ message: input.message }] }
      }
    }


    // For now, I want to surface the bank selection,
    // but eventually move out of graphql resolver
    const wallet = await WalletsRepository().findById(walletId)
    if (wallet instanceof RepositoryError) return new ValidationError(wallet)
    const account = await AccountsRepository().findById(wallet.accountId)
    if (account instanceof RepositoryError) return new ValidationError(account)
    if (!account.erpParty) return new Error("Could not find erpParty for account")
    const banks = await ErpNext.getBankAccountsByCustomer(account.erpParty)
    if (banks instanceof Error) return banks
    if (!banks.length) return Error(`Could not find banks for customer: ${account.erpParty}`)

    const offer = await (OffersManager.createCashoutOffer(
      walletId,
      amount, 
      banks[0], // todo: allow user to select bank account
    ))
    if (offer instanceof Error) return { errors: mapToGqlErrorList(offer) }

    return {
      errors: [],
      offer
    }
  },
})

export default RequestCashoutMutation