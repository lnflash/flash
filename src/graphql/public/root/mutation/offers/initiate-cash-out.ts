
import OffersManager from "@app/offers/OffersManager"
import { Cashout } from "@config"
import { NotImplementedError } from "@domain/errors"
import { mapToGqlErrorList } from "@graphql/error-map"
import { GT } from "@graphql/index"
import SuccessPayload from "@graphql/shared/types/payload/success-payload"
import WalletId from "@graphql/shared/types/scalar/wallet-id"
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

const InitiateCashoutMutation = GT.Field({
  description: dedent`Start the Cashout process; 
    User sends USD to Flash via Ibex and receives USD or JMD to bank account.`,
  args: {
    input: { type: GT.NonNull(InitiateCashoutInput) },
  },
  type: GT.NonNull(SuccessPayload),
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

    const status = await (OffersManager.executeOffer(offerId, walletId))
    if (status instanceof Error) return { errors: mapToGqlErrorList(status) }

    return { errors: [], success: true }
  },
})

export default InitiateCashoutMutation