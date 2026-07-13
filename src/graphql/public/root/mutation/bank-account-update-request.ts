import { Accounts } from "@app"
import { GT } from "@graphql/index"
import { mapToGqlErrorList } from "@graphql/error-map"
import AccountNumber from "@graphql/shared/types/scalar/account-number"
import IError from "@graphql/shared/types/abstract/error"

const BankAccountUpdateRequestInput = GT.Input({
  name: "BankAccountUpdateRequestInput",
  fields: () => ({
    bankAccountId: {
      type: GT.NonNull(GT.ID),
      description: "ERPNext identifier of the account to update",
    },
    bankName: { type: GT.NonNull(GT.String) },
    bankBranch: { type: GT.NonNull(GT.String) },
    accountType: { type: GT.NonNull(GT.String) },
    currency: {
      type: GT.NonNull(GT.String),
      description: "Must match the account's current currency (currency is locked)",
    },
    accountNumber: { type: GT.NonNull(AccountNumber) },
  }),
})

type BankAccountUpdateRequestInputType = {
  bankAccountId: string
  bankName: string
  bankBranch: string
  accountType: string
  currency: string
  accountNumber: string
}

const Response = GT.Object({
  name: "BankAccountUpdateRequestPayload",
  fields: () => ({
    errors: {
      type: GT.List(IError),
    },
    status: {
      type: GT.String,
      description: "Status of the created request (Pending on success)",
    },
  }),
})

const BankAccountUpdateRequestMutation = GT.Field({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(Response),
  args: {
    input: { type: GT.NonNull(BankAccountUpdateRequestInput) },
  },
  resolve: async (
    _,
    args: { input: BankAccountUpdateRequestInputType },
    { domainAccount }: { domainAccount: Account },
  ) => {
    const { bankAccountId, bankName, bankBranch, accountType, currency, accountNumber } =
      args.input

    const result = await Accounts.createBankAccountUpdateRequest(domainAccount.id, {
      bankAccountId,
      bankAccount: {
        bank: bankName,
        branch_code: bankBranch,
        account_type: accountType,
        currency,
        bank_account_no: accountNumber,
      },
    })

    if (result instanceof Error) return { errors: mapToGqlErrorList(result) }
    return { errors: [], status: result.status }
  },
})

export default BankAccountUpdateRequestMutation
