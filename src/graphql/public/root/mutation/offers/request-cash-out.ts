import OffersManager from "@app/offers/OffersManager"
import { mapToGqlErrorList } from "@graphql/error-map"
import { GT } from "@graphql/index"
import CashoutOffer from "@graphql/public/types/object/cashout-offer"
import FractionalCentAmount from "@graphql/public/types/scalar/cent-amount-fraction"
import IError from "@graphql/shared/types/abstract/error"
import WalletId from "@graphql/shared/types/scalar/wallet-id"
import { baseLogger } from "@services/logger"
import dedent from "dedent"

const RequestCashoutInput = GT.Input({
  name: "RequestCashoutInput",
  fields: () => ({
    walletId: {
      type: GT.NonNull(WalletId),
      description: "ID for a USD wallet belonging to the current user.",
    },
    usdAmount: { 
      type: GT.NonNull(FractionalCentAmount), 
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
    const { walletId, usdAmount } = args.input
    for (const input of [walletId, usdAmount]) {
      if (input instanceof Error) {
        return { errors: [{ message: input.message }] }
      }
    }

    const offer = await (OffersManager.createCashoutOffer(
      walletId, 
      { amount: BigInt(usdAmount), currency: "USD" }
    ))
    if (offer instanceof Error) return { errors: mapToGqlErrorList(offer) }

    baseLogger.info(offer, "offer")
    return {
      errors: [],
      offer
    }
  },
})

export default RequestCashoutMutation