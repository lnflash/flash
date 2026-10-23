import { GT } from "@graphql/index"
import { createOwnedOnChainAddress } from "@app/wallets/create-owned-on-chain-address"
import { InvalidWalletForAccountError } from "@domain/accounts"
import OnChainAddressPayload from "@graphql/public/types/payload/on-chain-address"
import WalletId from "@graphql/shared/types/scalar/wallet-id"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"

const OnChainAddressCreateInput = GT.Input({
  name: "OnChainAddressCreateInput",
  fields: () => ({
    walletId: { type: GT.NonNull(WalletId) },
  }),
})

const OnChainAddressCreateMutation = GT.Field<null, GraphQLPublicContextAuth>({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(OnChainAddressPayload),
  args: {
    input: { type: GT.NonNull(OnChainAddressCreateInput) },
  },
  resolve: async (_, args, { domainAccount }) => {
    const { walletId } = args.input
    if (walletId instanceof Error) {
      return { errors: [{ message: walletId.message }] }
    }

    if (!domainAccount)
      return {
        errors: [mapAndParseErrorForGqlResponse(new InvalidWalletForAccountError())],
      }

    const address = await createOwnedOnChainAddress({
      accountId: domainAccount.id,
      walletId,
    })
    if (address instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(address)] }
    }
    return {
      errors: [],
      address,
    }
  },
})

export default OnChainAddressCreateMutation
