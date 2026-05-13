import { GT } from "@graphql/index"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import BridgeWithdrawal from "@graphql/public/types/object/bridge-withdrawal"
import { BridgeConfig } from "@config"
import BridgeService from "@services/bridge"
import { BridgeDisabledError, BridgeAccountLevelError } from "@services/bridge/errors"

const BridgeInitiateWithdrawalInput = GT.Input({
  name: "BridgeInitiateWithdrawalInput",
  fields: () => ({
    amount: { type: GT.NonNull(GT.String) },
    externalAccountId: { type: GT.NonNull(GT.ID) },
  }),
})

const BridgeInitiateWithdrawalPayload = GT.Object({
  name: "BridgeInitiateWithdrawalPayload",
  fields: () => ({
    errors: { type: GT.List(GT.NonNull(Error)) },
    withdrawal: { type: BridgeWithdrawal },
  }),
})

const bridgeInitiateWithdrawal = GT.Field({
  type: GT.NonNull(BridgeInitiateWithdrawalPayload),
  args: {
    input: { type: GT.NonNull(BridgeInitiateWithdrawalInput) },
  },
  resolve: async (_, args, { domainAccount }: GraphQLPublicContextAuth) => {
    const { amount, externalAccountId } = args.input

    if (!BridgeConfig.enabled) {
      return { errors: [mapAndParseErrorForGqlResponse(new BridgeDisabledError())] }
    }

    if (!domainAccount || domainAccount.level < 2) {
      return { errors: [mapAndParseErrorForGqlResponse(new BridgeAccountLevelError())] }
    }

    const result = await BridgeService.initiateWithdrawal(
      domainAccount.id,
      amount,
      externalAccountId,
    )
    if (result instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(result)] }
    }

    return { withdrawal: result, errors: [] }
  },
})

export default bridgeInitiateWithdrawal
