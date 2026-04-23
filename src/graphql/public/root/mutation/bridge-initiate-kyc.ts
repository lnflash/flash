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

const BridgeInitiateKycInput = GT.Object({
  name: "BridgeInitiateKycInput",
  fields: () => ({
    email: { type: GT.String, nullable: true },
    type: { type: GT.String, nullable: true },
    full_name: { type: GT.String, nullable: true },
  }),
})

const bridgeInitiateKyc = GT.Field({
  type: GT.NonNull(BridgeInitiateKycPayload),
  args: {
    input: { type: GT.NonNull(BridgeInitiateKycInput) },
  },
  resolve: async (_, { input }, { domainAccount }: GraphQLPublicContextAuth) => {
    const { email, type, full_name } = input
    if (!BridgeConfig.enabled) {
      return { errors: [mapAndParseErrorForGqlResponse(new BridgeDisabledError())] }
    }

    if (!domainAccount || domainAccount.level < 2) {
      return { errors: [mapAndParseErrorForGqlResponse(new BridgeAccountLevelError())] }
    }

    const result = await BridgeService.initiateKyc({ accountId: domainAccount.id, email, type, full_name })
    if (result instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(result)] }
    }

    return { kycLink: result, errors: [] }
  },
})

export default bridgeInitiateKyc
