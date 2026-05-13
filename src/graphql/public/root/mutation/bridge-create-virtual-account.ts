import { GT } from "@graphql/index"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import BridgeVirtualAccount from "@graphql/public/types/object/bridge-virtual-account"
import { BridgeConfig } from "@config"
import BridgeService from "@services/bridge"
import { BridgeDisabledError, BridgeAccountLevelError } from "@services/bridge/errors"

const BridgeCreateVirtualAccountPayload = GT.Object({
  name: "BridgeCreateVirtualAccountPayload",
  fields: () => ({
    errors: { type: GT.List(GT.NonNull(Error)) },
    virtualAccount: { type: BridgeVirtualAccount },
  }),
})

const bridgeCreateVirtualAccount = GT.Field({
  type: GT.NonNull(BridgeCreateVirtualAccountPayload),
  resolve: async (_, __, { domainAccount }: GraphQLPublicContextAuth) => {
    if (!BridgeConfig.enabled) {
      return { errors: [mapAndParseErrorForGqlResponse(new BridgeDisabledError())] }
    }

    if (!domainAccount || domainAccount.level < 2) {
      return { errors: [mapAndParseErrorForGqlResponse(new BridgeAccountLevelError())] }
    }

    const result = await BridgeService.createVirtualAccount(domainAccount.id)
    if (result instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(result)] }
    }

    return { virtualAccount: result, errors: [] }
  },
})

export default bridgeCreateVirtualAccount
