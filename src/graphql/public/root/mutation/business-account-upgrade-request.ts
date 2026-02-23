import { Accounts } from "@app"
import { GT } from "@graphql/index"
import { apolloErrorResponse, mapToGqlErrorList } from "@graphql/error-map"
import AccountLevel from "@graphql/shared/types/scalar/account-level"
import IError from "@graphql/shared/types/abstract/error"
import { SetDocTypeValueError } from "@services/frappe/errors"
import { InternalServerError } from "@graphql/error"

const BankAccountInput = GT.Input({
  name: "BankAccountInput",
  fields: () => ({
    bankName: { type: GT.NonNull(GT.String) },
    bankBranch: { type: GT.NonNull(GT.String) },
    accountType: { type: GT.NonNull(GT.String) },
    currency: { type: GT.NonNull(GT.String) },
    accountNumber: { type: GT.NonNull(GT.Int) },
  }),
})

const AddressInput = GT.Input({
  name: "AddressInput",
  fields: () => ({
    title: { type: GT.NonNull(GT.String) },
    line1: { type: GT.NonNull(GT.String) },
    line2: { type: GT.String },
    city: { type: GT.NonNull(GT.String) },
    state: { type: GT.NonNull(GT.String) },
    postalCode: { type: GT.String },
    country: { type: GT.NonNull(GT.String) },
  }),
})

const BusinessAccountUpgradeRequestInput = GT.Input({
  name: "BusinessAccountUpgradeRequestInput",
  fields: () => ({
    level: { type: GT.NonNull(AccountLevel) },
    fullName: { type: GT.NonNull(GT.String) },
    address: { type: GT.NonNull(AddressInput) },
    terminalsRequested: { type: GT.Int, defaultValue: 0 },
    bankAccount: { type: BankAccountInput },
    idDocument: { type: GT.String },
  }),
})

const Response = GT.Object({
  name: "AccountUpgradePayload",
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

const BusinessAccountUpgradeRequestMutation = GT.Field({
  extensions: {
    complexity: 150,
  },
  type: GT.NonNull(Response),
  args: {
    input: { type: GT.NonNull(BusinessAccountUpgradeRequestInput) },
  },
  resolve: async (_, args, { domainAccount }: { domainAccount: Account }) => {
    const result = await Accounts.createUpgradeRequest(domainAccount.id, args.input)
    if (result instanceof SetDocTypeValueError) return apolloErrorResponse(new InternalServerError({ message: "Pending upgrade request(s) failed to update." }))
    if (result instanceof Error) return { errors: mapToGqlErrorList(result) }
    else return result
  },
})

export default BusinessAccountUpgradeRequestMutation
