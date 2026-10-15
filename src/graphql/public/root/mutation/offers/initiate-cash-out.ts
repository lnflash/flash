import CashoutManager from "@app/offers/CashoutManager"
import { Cashout } from "@config"
import { OfferAlreadyExecuted } from "@domain/cache"
import { NotImplementedError } from "@domain/errors"
import { ErrorLevel } from "@domain/shared"
import { InternalServerError } from "@graphql/error"
import { mapToGqlErrorList } from "@graphql/error-map"
import { GT } from "@graphql/index"
import IError from "@graphql/shared/types/abstract/error"
import WalletId from "@graphql/shared/types/scalar/wallet-id"
import { baseLogger } from "@services/logger"
import { recordExceptionInCurrentSpan } from "@services/tracing"
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
    id: {
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
  resolve: async (_, args, { domainAccount }: GraphQLPublicContextAuth) => {
    if (!Cashout.Enabled) return new NotImplementedError("Cashout feature is not enabled")
    if (!domainAccount) throw new Error("Authentication required")

    const { offerId, walletId } = args.input
    // Parse for input errors
    for (const f of [offerId, walletId]) {
      if (f instanceof Error) return { errors: [{ message: f.message, success: false }] }
    }

    const offer = await CashoutManager.executeCashout(offerId, walletId, domainAccount.id)
    // Expected, not a fault: this offer was already executed, by an earlier
    // call or a concurrent duplicate. Return the typed code so the client can
    // ask for a new offer, and keep it out of the Critical exception stream.
    if (offer instanceof OfferAlreadyExecuted)
      return { errors: mapToGqlErrorList(offer), id: null }
    if (offer instanceof Error) {
      recordExceptionInCurrentSpan({
        error: offer,
        level: ErrorLevel.Critical,
        attributes: { offerId },
      })
      return new InternalServerError({
        message: "Server error. Please contact support",
        logger: baseLogger,
      })
    }

    return { errors: [], id: offer.cashoutId }
  },
})

export default InitiateCashoutMutation
