import { GT } from "@graphql/index"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import IError from "@graphql/shared/types/abstract/error"
import BridgeKycLink from "@graphql/public/types/object/bridge-kyc-link"
import { BridgeConfig } from "@config"
import BridgeService from "@services/bridge"
import { BridgeDisabledError, BridgeAccountLevelError } from "@services/bridge/errors"
import { assertBridgeKycEligible } from "@app/bridge/kyc-gate"

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
  resolve: async (_, { input }, { domainAccount, user }: GraphQLPublicContextAuth) => {
    const { email, type, full_name } = input
    if (!BridgeConfig.enabled) {
      return { errors: [mapAndParseErrorForGqlResponse(new BridgeDisabledError())] }
    }

    if (!domainAccount || domainAccount.level <= 0) {
      return { errors: [mapAndParseErrorForGqlResponse(new BridgeAccountLevelError())] }
    }

    // Bridge approves KYC for residents of countries it then refuses a USD
    // virtual account to. Check phone-country eligibility (ops-managed in
    // ERPNext) before sending the user through KYC — config `bridge.kycGate`.
    const eligible = await assertBridgeKycEligible({
      account: domainAccount,
      user,
      config: BridgeConfig.kycGate,
    })
    if (eligible instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(eligible)] }
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
