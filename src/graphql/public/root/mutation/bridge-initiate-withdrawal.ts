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
    const { amount, externalAccountId } = args.input

    // validate the amount is positive and has at most 6 decimal places
    if (!/^\d+(\.\d{1,6})?$/.test(amount) || parseFloat(amount) <= 0) {
      return {
        errors: [mapAndParseErrorForGqlResponse(new BridgeInvalidAmountError())],
      }
    }

    // validate the amount is greater than the minimum withdrawal amount
    if (parseFloat(amount) < BridgeConfig.minWithdrawalAmount) {
      return {
        errors: [mapAndParseErrorForGqlResponse(new BridgeBelowMinimumWithdrawalError(BridgeConfig.minWithdrawalAmount))],
      }
    }

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
