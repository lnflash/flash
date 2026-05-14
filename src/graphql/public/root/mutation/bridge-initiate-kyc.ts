import { GT } from "@graphql/index"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import IError from "@graphql/shared/types/abstract/error"
import BridgeKycLink from "@graphql/public/types/object/bridge-kyc-link"
import { BridgeConfig } from "@config"
import BridgeService from "@services/bridge"
import { BridgeDisabledError, BridgeAccountLevelError } from "@services/bridge/errors"

const BridgeInitiateKycPayload = GT.Object({
  name: "BridgeInitiateKycPayload",
  fields: () => ({
    errors: { type: GT.NonNullList(IError) },
    kycLink: { type: BridgeKycLink },
  }),
})

const BridgeInitiateKycInput = GT.Input({
  name: "BridgeInitiateKycInput",
  fields: () => ({
    email: { type: GT.String },
    type: { type: GT.String },
    full_name: { type: GT.String },
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

    const result = await BridgeService.initiateKyc({
      accountId: domainAccount.id,
      email,
      type,
      full_name,
    })
    if (result instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(result)] }
    }

    return { kycLink: result, errors: [] }
  },
})

export default bridgeInitiateKyc
