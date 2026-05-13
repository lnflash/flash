import { GT } from "@graphql/index"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import BridgeExternalAccount from "@graphql/public/types/object/bridge-external-account"
import { BridgeConfig } from "@config"
import BridgeService from "@services/bridge"
import { BridgeDisabledError } from "@services/bridge/errors"

const bridgeExternalAccounts = GT.Field({
  type: GT.List(BridgeExternalAccount),
  resolve: async (_, __, { domainAccount }: GraphQLPublicContextAuth) => {
    if (!BridgeConfig.enabled) {
      throw mapAndParseErrorForGqlResponse(new BridgeDisabledError())
    }

    if (!domainAccount) return null

    const result = await BridgeService.getExternalAccounts(domainAccount.id)
    if (result instanceof Error) {
      throw mapAndParseErrorForGqlResponse(result)
    }

    return result
  },
})

export default bridgeExternalAccounts
