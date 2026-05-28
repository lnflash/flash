import { GT } from "@graphql/index"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import IError from "@graphql/shared/types/abstract/error"
import BridgeExternalAccountLink from "@graphql/public/types/object/bridge-external-account-link"
import { BridgeConfig } from "@config"
import BridgeService from "@services/bridge"
import { BridgeDisabledError, BridgeAccountLevelError } from "@services/bridge/errors"

const BridgeAddExternalAccountPayload = GT.Object({
  name: "BridgeAddExternalAccountPayload",
  fields: () => ({
    errors: { type: GT.NonNullList(IError) },
    externalAccount: { type: BridgeExternalAccountLink },
  }),
})

const bridgeAddExternalAccount = GT.Field({
  type: GT.NonNull(BridgeAddExternalAccountPayload),
  resolve: async (_, __, { domainAccount }: GraphQLPublicContextAuth) => {
    if (!BridgeConfig.enabled) {
      return { errors: [mapAndParseErrorForGqlResponse(new BridgeDisabledError())] }
    }

    if (!domainAccount || domainAccount.level < 2) {
      return { errors: [mapAndParseErrorForGqlResponse(new BridgeAccountLevelError())] }
    }

    const result = await BridgeService.addExternalAccount(domainAccount.id)
    if (result instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(result)] }
    }

    return { externalAccount: result, errors: [] }
  },
})

export default bridgeAddExternalAccount
