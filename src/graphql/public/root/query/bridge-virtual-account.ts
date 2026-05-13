import { GT } from "@graphql/index"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import BridgeVirtualAccount from "@graphql/public/types/object/bridge-virtual-account"
import { BridgeConfig } from "@config"
import BridgeService from "@services/bridge"
import { BridgeDisabledError } from "@services/bridge/errors"

const bridgeVirtualAccount = GT.Field({
  type: BridgeVirtualAccount,
  resolve: async (_, __, { domainAccount }: GraphQLPublicContextAuth) => {
    if (!BridgeConfig.enabled) {
      throw mapAndParseErrorForGqlResponse(new BridgeDisabledError())
    }

    if (!domainAccount) return null

    const result = await BridgeService.getVirtualAccount(domainAccount.id)
    if (result instanceof Error) {
      throw mapAndParseErrorForGqlResponse(result)
    }

    return result
  },
})

export default bridgeVirtualAccount
