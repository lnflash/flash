
import OffersManager from "@app/offers/OffersManager"
import { Cashout } from "@config"
import { NotImplementedError } from "@domain/errors"
import { InternalServerError, LightningPaymentError } from "@graphql/error"
import { GT } from "@graphql/index"
import IError from "@graphql/shared/types/abstract/error"
import WalletId from "@graphql/shared/types/scalar/wallet-id"
import { baseLogger } from "@services/logger"
import dedent from "dedent"

const InitiateCashoutInput = GT.Input({
  name: "InitiateCashoutInput",
  fields: () => ({
    walletId: { type: GT.NonNull(WalletId) }, // Required for auth at the wallet level
    offerId: {
      type: GT.NonNullID,
      description: "The id of the offer being executed.",
    },
  }),
})

const InitiatedCashoutResponse = GT.Object({
  name: "InitiatedCashoutResponse",
  fields: () => ({
    errors: {
      type: GT.NonNullList(IError),
    },
    journalId: {
      type: GT.ID,
    },
  }),
})

const InitiateCashoutMutation = GT.Field({
  description: dedent`Start the Cashout process; 
    User sends USD to Flash via Ibex and receives USD or JMD to bank account.`,
  args: {
    input: { type: GT.NonNull(InitiateCashoutInput) },
  },
  type: GT.NonNull(InitiatedCashoutResponse),
  extensions: {
    complexity: 60,
  },
  resolve: async (_, args) => {
    if (!Cashout.Enabled)
      return new NotImplementedError("Cashout feature is not enabled")

    const { offerId, walletId } = args.input
    // Parse for input errors
    for (const f of [offerId, walletId]) {
      if (f instanceof Error) return { errors: [{ message: f.message, success: false }] }
    }

    const offer = await (OffersManager.executeCashout(offerId, walletId))
    // if (status instanceof IbexError) return new LightningPaymentError({ message: "Payment failure.", logger: baseLogger })
    if (offer instanceof Error) {
      return new InternalServerError({ message: "Server error. Please contact support", logger: baseLogger })
    }

    return { errors: [], journalId: offer.journalId }
  },
})

export default InitiateCashoutMutation