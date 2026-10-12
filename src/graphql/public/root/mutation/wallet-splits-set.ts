import dedent from "dedent"

import { setPaymentSplits } from "@app/payment-splits/set-splits"

import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import { GT } from "@graphql/index"
import WalletSplitsSetPayload from "@graphql/public/types/payload/wallet-splits-set"
import WalletId from "@graphql/shared/types/scalar/wallet-id"

const WalletSplitInput = GT.Input({
  name: "WalletSplitInput",
  fields: () => ({
    destination: {
      type: GT.NonNull(GT.String),
      description: "A Flash username or a walletId in the same currency.",
    },
    percent: {
      type: GT.NonNull(GT.Int),
      description: "Whole percent of each receive, from 1 to 100.",
    },
  }),
})

const WalletSplitsSetInput = GT.Input({
  name: "WalletSplitsSetInput",
  fields: () => ({
    walletId: {
      type: GT.NonNull(WalletId),
      description: "The wallet whose incoming payments are split.",
    },
    splits: {
      type: GT.NonNullList(WalletSplitInput),
      description:
        "The complete split set. Replaces every existing split; an empty list clears them all.",
    },
  }),
})

const WalletSplitsSetMutation = GT.Field<
  null,
  GraphQLPublicContextAuth,
  {
    input: {
      walletId: WalletId | InputValidationError
      splits: { destination: string; percent: number }[]
    }
  }
>({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(WalletSplitsSetPayload),
  description: dedent`Replaces the payment splits on a USD or USDT wallet. Each
  external Lightning receive on the wallet then pays the given percentages on
  to the destination wallets. Percentages must add up to at most 100.`,
  args: {
    input: { type: GT.NonNull(WalletSplitsSetInput) },
  },
  resolve: async (_, args, { domainAccount }) => {
    const { walletId, splits } = args.input
    if (walletId instanceof Error) {
      return { errors: [{ message: walletId.message }] }
    }

    const result = await setPaymentSplits({
      account: domainAccount,
      walletId,
      splits,
    })
    if (result instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(result)] }
    }

    return { errors: [], splits: result }
  },
})

export default WalletSplitsSetMutation
