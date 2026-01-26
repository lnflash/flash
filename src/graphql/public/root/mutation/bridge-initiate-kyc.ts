import { GT } from "@graphql/index"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import BridgeKycLink from "@graphql/public/types/object/bridge-kyc-link"
import { BridgeConfig } from "@config"
import BridgeService from "@services/bridge"
import { BridgeDisabledError, BridgeAccountLevelError } from "@services/bridge/errors"

const BridgeInitiateKycPayload = GT.Object({
  name: "BridgeInitiateKycPayload",
  fields: () => ({
    errors: { type: GT.List(GT.NonNull(Error)) },
    kycLink: { type: BridgeKycLink },
  }),
})

const bridgeInitiateKyc = GT.Field({
  type: GT.NonNull(BridgeInitiateKycPayload),
  resolve: async (_, __, { domainAccount }: GraphQLPublicContextAuth) => {
    if (!BridgeConfig.enabled) {
      return { errors: [mapAndParseErrorForGqlResponse(new BridgeDisabledError())] }
    }

    if (!domainAccount || domainAccount.level < 2) {
      return { errors: [mapAndParseErrorForGqlResponse(new BridgeAccountLevelError())] }
    }

    const result = await BridgeService.initiateKyc(domainAccount.id)
    if (result instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(result)] }
    }

    return { kycLink: result, errors: [] }
  },
})

export default bridgeInitiateKyc
