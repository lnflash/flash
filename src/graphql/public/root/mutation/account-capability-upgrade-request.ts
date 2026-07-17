import { Accounts } from "@app"
import { RequestableCapability } from "@domain/accounts"
import { GT } from "@graphql/index"
import { apolloErrorResponse, mapToGqlErrorList } from "@graphql/error-map"
import IError from "@graphql/shared/types/abstract/error"
import { SetDocTypeValueError } from "@services/frappe/errors"
import { InternalServerError } from "@graphql/error"

import {
  AddressInput,
  BankAccountInput,
  parseBankAccountInput,
} from "./business-account-upgrade-request"

// ENG-516: clients request one capability instead of picking a whole tier.
// The target internal level is derived server-side by the capability state
// machine; Pro/International/Merchant nomenclature is retired.
const AccountCapability = GT.Enum({
  name: "AccountCapability",
  values: {
    BANK_PAYOUT: { value: RequestableCapability.BankPayout },
    BUSINESS: { value: RequestableCapability.Business },
  },
})

const AccountCapabilityUpgradeRequestInput = GT.Input({
  name: "AccountCapabilityUpgradeRequestInput",
  fields: () => ({
    capability: { type: GT.NonNull(AccountCapability) },
    fullName: { type: GT.NonNull(GT.String) },
    address: { type: GT.NonNull(AddressInput) },
    terminalsRequested: { type: GT.Int, defaultValue: 0 },
    bankAccount: { type: BankAccountInput },
    idDocument: { type: GT.String },
  }),
})

const Response = GT.Object({
  name: "AccountCapabilityUpgradeRequestPayload",
  fields: () => ({
    errors: {
      type: GT.List(IError),
    },
    id: {
      type: GT.String,
    },
    status: {
      type: GT.String,
    },
  }),
})

const AccountCapabilityUpgradeRequestMutation = GT.Field({
  extensions: {
    complexity: 150,
  },
  type: GT.NonNull(Response),
  args: {
    input: { type: GT.NonNull(AccountCapabilityUpgradeRequestInput) },
  },
  resolve: async (_, args, { domainAccount }: { domainAccount: Account }) => {
    const { bankAccount, ...rest } = args.input
    const result = await Accounts.requestCapabilityUpgrade(domainAccount.id, {
      ...rest,
      bankAccount: bankAccount ? parseBankAccountInput(bankAccount) : undefined,
    })
    if (result instanceof SetDocTypeValueError)
      return apolloErrorResponse(
        new InternalServerError({
          message: "Pending upgrade request(s) failed to update.",
        }),
      )
    if (result instanceof Error) return { errors: mapToGqlErrorList(result) }
    else return result
  },
})

export default AccountCapabilityUpgradeRequestMutation
