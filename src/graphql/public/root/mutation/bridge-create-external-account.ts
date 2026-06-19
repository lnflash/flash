import { GT } from "@graphql/index"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import IError from "@graphql/shared/types/abstract/error"
import BridgeExternalAccount from "@graphql/public/types/object/bridge-external-account"
import BridgeCreateExternalAccountInput from "@graphql/public/types/input/bridge-create-external-account-input"
import { BridgeConfig } from "@config"
import BridgeService from "@services/bridge"
import { BridgeDisabledError, BridgeAccountLevelError } from "@services/bridge/errors"

const BridgeCreateExternalAccountPayload = GT.Object({
  name: "BridgeCreateExternalAccountPayload",
  fields: () => ({
    errors: { type: GT.NonNullList(IError) },
    externalAccount: { type: BridgeExternalAccount },
  }),
})

const bridgeCreateExternalAccount = GT.Field({
  type: GT.NonNull(BridgeCreateExternalAccountPayload),
  args: {
    input: { type: GT.NonNull(BridgeCreateExternalAccountInput) },
  },
  resolve: async (
    _,
    {
      input,
    }: {
      input: {
        bankName: string
        accountNumber: string
        routingNumber: string
        accountOwnerName: string
        checkingOrSavings?: string
        streetLine1: string
        city: string
        state: string
        postalCode: string
        country: string
      }
    },
    { domainAccount }: GraphQLPublicContextAuth,
  ) => {
    if (!BridgeConfig.enabled) {
      return { errors: [mapAndParseErrorForGqlResponse(new BridgeDisabledError())] }
    }

    if (!domainAccount || domainAccount.level <= 0) {
      return { errors: [mapAndParseErrorForGqlResponse(new BridgeAccountLevelError())] }
    }

    const result = await BridgeService.createExternalAccount(domainAccount.id, {
      account_owner_name: input.accountOwnerName,
      bank_name: input.bankName,
      currency: "usd",
      account_type: "us",
      account: {
        account_number: input.accountNumber,
        routing_number: input.routingNumber,
        checking_or_savings:
          (input.checkingOrSavings as "checking" | "savings") ?? "checking",
      },
      address: {
        street_line_1: input.streetLine1,
        city: input.city,
        state: input.state,
        postal_code: input.postalCode,
        country: input.country,
      },
    })

    if (result instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(result)] }
    }

    return { externalAccount: result, errors: [] }
  },
})

export default bridgeCreateExternalAccount
