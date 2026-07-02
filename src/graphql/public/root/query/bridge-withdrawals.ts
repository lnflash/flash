import { GT } from "@graphql/index"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import BridgeWithdrawal from "@graphql/public/types/object/bridge-withdrawal"
import { BridgeConfig } from "@config"
import BridgeService from "@services/bridge"
import { BridgeDisabledError } from "@services/bridge/errors"

const bridgeWithdrawals = GT.Field({
  type: GT.List(BridgeWithdrawal),
  resolve: async (_, __, { domainAccount }: GraphQLPublicContextAuth) => {
    if (!BridgeConfig.enabled) {
      throw mapAndParseErrorForGqlResponse(new BridgeDisabledError())
    }

    if (!domainAccount) return null

    const result = await BridgeService.getWithdrawals(domainAccount.id)
    if (result instanceof Error) {
      throw mapAndParseErrorForGqlResponse(result)
    }

    return result
  },
})

export default bridgeWithdrawals
