import { GT } from "@graphql/index"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import WalletId from "@graphql/shared/types/scalar/wallet-id"
import OnChainAddressPayload from "@graphql/public/types/payload/on-chain-address"
// import { Wallets } from "@app"

// FLASH FORK: import ibex dependencies
import { client as Ibex } from "@services/ibex"
import { IbexClientError } from "@services/ibex/client/errors"

const OnChainAddressCurrentInput = GT.Input({
  name: "OnChainAddressCurrentInput",
  fields: () => ({
    walletId: { type: GT.NonNull(WalletId) },
  }),
})

const OnChainAddressCurrentMutation = GT.Field({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(OnChainAddressPayload),
  args: {
    input: { type: GT.NonNull(OnChainAddressCurrentInput) },
  },
  resolve: async (_, args) => {
    const { walletId } = args.input
    if (walletId instanceof Error) {
      return { errors: [{ message: walletId.message }] }
    }

    // FLASH FORK: use IBEX to create on-chain address
    // const address = await Wallets.getLastOnChainAddress(walletId)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any

    const resp = await Ibex.generateBitcoinAddress({
      accountId: walletId,
    })

<<<<<<< HEAD:core/api/src/graphql/public/root/mutation/on-chain-address-current.ts
    if (resp instanceof IbexEventError) {
      return { errors: [mapAndParseErrorForGqlResponse(resp)] }
=======
    if (resp instanceof IbexClientError) {
      return { errors: [mapAndParseErrorForGqlResponse(resp)] } 
>>>>>>> 0d0e35dcc (Refactor Ibex client & webhook-server (#33)):src/graphql/public/root/mutation/on-chain-address-current.ts
    }

    return {
      errors: [],
      address: resp.address,
    }
  },
})

export default OnChainAddressCurrentMutation
