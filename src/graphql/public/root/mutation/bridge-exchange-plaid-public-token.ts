import { GT } from "@graphql/index"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import IError from "@graphql/shared/types/abstract/error"
import BridgeExchangePlaidPublicTokenInput from "@graphql/public/types/input/bridge-exchange-plaid-public-token-input"
import { BridgeConfig } from "@config"
import BridgeService from "@services/bridge"
import { BridgeDisabledError, BridgeAccountLevelError } from "@services/bridge/errors"

const BridgeExchangePlaidPublicTokenPayload = GT.Object({
  name: "BridgeExchangePlaidPublicTokenPayload",
  fields: () => ({
    errors: { type: GT.NonNullList(IError) },
    message: { type: GT.String },
  }),
})

const bridgeExchangePlaidPublicToken = GT.Field({
  type: GT.NonNull(BridgeExchangePlaidPublicTokenPayload),
  args: {
    input: { type: GT.NonNull(BridgeExchangePlaidPublicTokenInput) },
  },
  resolve: async (
    _,
    { input }: { input: { linkToken: string; publicToken: string } },
    { domainAccount }: GraphQLPublicContextAuth,
  ) => {
    if (!BridgeConfig.enabled) {
      return { errors: [mapAndParseErrorForGqlResponse(new BridgeDisabledError())] }
    }

    if (!domainAccount || domainAccount.level <= 0) {
      return { errors: [mapAndParseErrorForGqlResponse(new BridgeAccountLevelError())] }
    }

    const result = await BridgeService.exchangePlaidPublicToken(
      domainAccount.id,
      input.linkToken,
      input.publicToken,
    )
    if (result instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(result)] }
    }

    return { message: result.message, errors: [] }
  },
})

export default bridgeExchangePlaidPublicToken
