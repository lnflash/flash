import { GT } from "@graphql/index"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import BridgeVirtualAccount from "@graphql/public/types/object/bridge-virtual-account"
import { BridgeConfig } from "@config"
import BridgeService from "@services/bridge"
import { BridgeAccountLevelError, BridgeDisabledError } from "@services/bridge/errors"

const bridgeVirtualAccount = GT.Field({
  type: BridgeVirtualAccount,
  resolve: async (_, __, { domainAccount }: GraphQLPublicContextAuth) => {
    if (!BridgeConfig.enabled) {
      throw mapAndParseErrorForGqlResponse(new BridgeDisabledError())
    }

    if (!domainAccount) return null

    if (domainAccount.level < 2) {
      throw mapAndParseErrorForGqlResponse(new BridgeAccountLevelError())
    }

    // KYC exists but not yet approved
    if (domainAccount.bridgeKycStatus !== "approved") {
      return {
        pending: true,
        message: "KYC verification is pending. Please wait for approval.",
      }
    }

    // KYC approved — return existing virtual account
    const result = await BridgeService.getVirtualAccount(domainAccount.id)
    if (result instanceof Error) {
      throw mapAndParseErrorForGqlResponse(result)
    }

    return result
  },
})

export default bridgeVirtualAccount
