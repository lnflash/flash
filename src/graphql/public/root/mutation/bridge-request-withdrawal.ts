import { GT } from "@graphql/index"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import IError from "@graphql/shared/types/abstract/error"
import BridgeWithdrawal from "@graphql/public/types/object/bridge-withdrawal"
import { BridgeConfig } from "@config"
import BridgeService from "@services/bridge"
import {
  BridgeDisabledError,
  BridgeAccountLevelError,
  BridgeInvalidAmountError,
  BridgeBelowMinimumWithdrawalError,
} from "@services/bridge/errors"

const BridgeRequestWithdrawalInput = GT.Input({
  name: "BridgeRequestWithdrawalInput",
  fields: () => ({
    amount: { type: GT.NonNull(GT.String) },
    externalAccountId: { type: GT.NonNull(GT.ID) },
  }),
})

const BridgeRequestWithdrawalPayload = GT.Object({
  name: "BridgeRequestWithdrawalPayload",
  fields: () => ({
    errors: { type: GT.NonNullList(IError) },
    withdrawal: { type: BridgeWithdrawal },
  }),
})

const bridgeRequestWithdrawal = GT.Field({
  type: GT.NonNull(BridgeRequestWithdrawalPayload),
  args: {
    input: { type: GT.NonNull(BridgeRequestWithdrawalInput) },
  },
  resolve: async (_, args, { domainAccount }: GraphQLPublicContextAuth) => {
    const { amount, externalAccountId } = args.input

    if (!/^\d+(\.\d{1,6})?$/.test(amount) || parseFloat(amount) <= 0) {
      return {
        errors: [mapAndParseErrorForGqlResponse(new BridgeInvalidAmountError())],
      }
    }

    if (parseFloat(amount) < BridgeConfig.minWithdrawalAmount) {
      return {
        errors: [
          mapAndParseErrorForGqlResponse(
            new BridgeBelowMinimumWithdrawalError(BridgeConfig.minWithdrawalAmount),
          ),
        ],
      }
    }

    if (!BridgeConfig.enabled) {
      return { errors: [mapAndParseErrorForGqlResponse(new BridgeDisabledError())] }
    }

    if (!domainAccount || domainAccount.level <= 0) {
      return { errors: [mapAndParseErrorForGqlResponse(new BridgeAccountLevelError())] }
    }

    const result = await BridgeService.requestWithdrawal(
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

export default bridgeRequestWithdrawal
