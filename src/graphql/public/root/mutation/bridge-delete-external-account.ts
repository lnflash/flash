import { GT } from "@graphql/index"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import IError from "@graphql/shared/types/abstract/error"
import BridgeExternalAccount from "@graphql/public/types/object/bridge-external-account"
import { BridgeConfig } from "@config"
import BridgeService from "@services/bridge"
import { BridgeDisabledError, BridgeAccountLevelError } from "@services/bridge/errors"

const BridgeDeleteExternalAccountInput = GT.Input({
  name: "BridgeDeleteExternalAccountInput",
  fields: () => ({
    externalAccountId: { type: GT.NonNull(GT.ID) },
  }),
})

const BridgeDeleteExternalAccountPayload = GT.Object({
  name: "BridgeDeleteExternalAccountPayload",
  fields: () => ({
    errors: { type: GT.NonNullList(IError) },
    externalAccount: { type: BridgeExternalAccount },
  }),
})

const bridgeDeleteExternalAccount = GT.Field({
  type: GT.NonNull(BridgeDeleteExternalAccountPayload),
  args: {
    input: { type: GT.NonNull(BridgeDeleteExternalAccountInput) },
  },
  resolve: async (
    _,
    { input }: { input: { externalAccountId: string } },
    { domainAccount }: GraphQLPublicContextAuth,
  ) => {
    if (!BridgeConfig.enabled) {
      return { errors: [mapAndParseErrorForGqlResponse(new BridgeDisabledError())] }
    }

    if (!domainAccount || domainAccount.level <= 0) {
      return { errors: [mapAndParseErrorForGqlResponse(new BridgeAccountLevelError())] }
    }

    const result = await BridgeService.deleteExternalAccount(
      domainAccount.id,
      input.externalAccountId,
    )
    if (result instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(result)] }
    }

    return { externalAccount: result, errors: [] }
  },
})

export default bridgeDeleteExternalAccount
