import OffersManager from "@app/offers/OffersManager"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import { GT } from "@graphql/index"
import FractionalCentAmount from "@graphql/public/types/scalar/cent-amount-fraction"
import IError from "@graphql/shared/types/abstract/error"
import WalletId from "@graphql/shared/types/scalar/wallet-id"
import dedent from "dedent"
import JmdAmount from "@graphql/shared/types/scalar/jmd-amount"
import Timestamp from "@graphql/shared/types/scalar/timestamp"
import { baseLogger } from "@services/logger"

const RequestCashoutInput = GT.Input({
  name: "RequestCashoutInput",
  fields: () => ({
    walletId: {
      type: GT.NonNull(WalletId),
      description: "ID for a USD wallet belonging to the current user.",
    },
    amount: { type: GT.NonNull(FractionalCentAmount), description: "Amount in USD cents." },
  }),
})

const CashoutOffer = GT.Object({
  name: "CashoutOffer",
  fields: () => ({
    id: {
      type: GT.NonNullID,
      description: "ID of the offer",
    },
    walletId: {
      type: GT.NonNull(WalletId),
      description: "ID for the users USD wallet to send from",
    },
    ibexTransfer: {
      type: GT.NonNull(FractionalCentAmount), 
      description: "The amount the user is sending to flash" 
    },
    usdLiability: {
      type: GT.NonNull(FractionalCentAmount), 
      description: "The amount Flash owes to the user denominated in USD",
    },
    jmdLiability: {
      type: GT.NonNull(JmdAmount), 
      description: "The amount Flash owes to the user denominated in JMD",
    },
    exchangeRate: {
      type: GT.NonNull(GT.Float), 
      description: "The price to convert USD -> Flash",
    },
    flashFee: {
      type: GT.NonNull(FractionalCentAmount), 
      description: "The amount that Flash is charging for it's services",
    },
    expiresAt: {
      type: GT.NonNull(Timestamp), 
      description: "The time at which this offer is no longer accepted by Flash",
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
    const { walletId, amount } = args.input
    for (const input of [walletId, amount]) {
      if (input instanceof Error) {
        return { errors: [{ message: input.message }] }
      }
    }

    const offer = await (new OffersManager().makeCashoutOffer(
      walletId, 
      { amount: BigInt(amount), currency: "USD" }
    ))
    if (offer instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(offer)] }
    }

    baseLogger.info(offer, "CashoutResponse")
    return {
      errors: [],
      offer: offer,
    }
  },
})

export default RequestCashoutMutation