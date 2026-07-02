import { GT } from "@graphql/index"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import IError from "@graphql/shared/types/abstract/error"
import BridgeWithdrawal from "@graphql/public/types/object/bridge-withdrawal"
import { BridgeConfig } from "@config"
import BridgeService from "@services/bridge"
import { BridgeDisabledError, BridgeAccountLevelError } from "@services/bridge/errors"

const BridgeInitiateWithdrawalInput = GT.Input({
  name: "BridgeInitiateWithdrawalInput",
  fields: () => ({
    withdrawalId: { type: GT.NonNull(GT.ID) },
  }),
})

const BridgeInitiateWithdrawalPayload = GT.Object({
  name: "BridgeInitiateWithdrawalPayload",
  fields: () => ({
    errors: { type: GT.NonNullList(IError) },
    withdrawal: { type: BridgeWithdrawal },
  }),
})

const bridgeInitiateWithdrawal = GT.Field({
  type: GT.NonNull(BridgeInitiateWithdrawalPayload),
  args: {
    input: { type: GT.NonNull(BridgeInitiateWithdrawalInput) },
  },
  resolve: async (_, args, { domainAccount }: GraphQLPublicContextAuth) => {
    const { withdrawalId } = args.input

    if (!BridgeConfig.enabled) {
      return { errors: [mapAndParseErrorForGqlResponse(new BridgeDisabledError())] }
    }

    if (!domainAccount || domainAccount.level <= 0) {
      return { errors: [mapAndParseErrorForGqlResponse(new BridgeAccountLevelError())] }
    }

    const result = await BridgeService.initiateWithdrawal(domainAccount.id, withdrawalId)
    if (result instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(result)] }
    }

    return { withdrawal: result, errors: [] }
  },
})

export default bridgeInitiateWithdrawal
