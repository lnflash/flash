import { deletePaymentSplit } from "@app/payment-splits/delete-split"

import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import { GT } from "@graphql/index"
import SuccessPayload from "@graphql/shared/types/payload/success-payload"
import WalletId from "@graphql/shared/types/scalar/wallet-id"

const WalletSplitDeleteInput = GT.Input({
  name: "WalletSplitDeleteInput",
  fields: () => ({
    walletId: { type: GT.NonNull(WalletId) },
    splitId: { type: GT.NonNullID },
  }),
})

const WalletSplitDeleteMutation = GT.Field<
  null,
  GraphQLPublicContextAuth,
  { input: { walletId: WalletId | InputValidationError; splitId: string } }
>({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(SuccessPayload),
  description:
    "Deletes one payment split from a wallet. Splits already triggered still pay out.",
  args: {
    input: { type: GT.NonNull(WalletSplitDeleteInput) },
  },
  resolve: async (_, args, { domainAccount }) => {
    const { walletId, splitId } = args.input
    if (walletId instanceof Error) {
      return { errors: [{ message: walletId.message }], success: false }
    }

    const result = await deletePaymentSplit({
      account: domainAccount,
      walletId,
      splitId,
    })
    if (result instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(result)], success: false }
    }

    return { errors: [], success: true }
  },
})

export default WalletSplitDeleteMutation
