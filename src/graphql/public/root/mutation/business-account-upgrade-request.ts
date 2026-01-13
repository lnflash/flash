import { Accounts } from "@app"
import { GT } from "@graphql/index"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import AccountLevel from "@graphql/shared/types/scalar/account-level"
import SuccessPayload from "@graphql/shared/types/payload/success-payload"

const BusinessAccountUpgradeRequestInput = GT.Input({
  name: "BusinessAccountUpgradeRequestInput",
  fields: () => ({
    level: { type: GT.NonNull(AccountLevel) },
    fullName: { type: GT.NonNull(GT.String) },
    phoneNumber: { type: GT.String },
    email: { type: GT.String },
    businessName: { type: GT.String },
    businessAddress: { type: GT.String },
    terminalRequested: { type: GT.Boolean },
    bankName: { type: GT.String },
    bankBranch: { type: GT.String },
    accountType: { type: GT.String },
    currency: { type: GT.String },
    accountNumber: { type: GT.Int },
    idDocument: { type: GT.String, description: "Base64-encoded ID document file" },
  }),
})

const BusinessAccountUpgradeRequestMutation = GT.Field({
  extensions: {
    complexity: 150,
  },
  type: GT.NonNull(SuccessPayload),
  args: {
    input: { type: GT.NonNull(BusinessAccountUpgradeRequestInput) },
  },
  resolve: async (_, args, { domainAccount }: { domainAccount: Account }) => {
    const {
      level,
      fullName,
      phoneNumber,
      email,
      businessName,
      businessAddress,
      terminalRequested,
      bankName,
      bankBranch,
      accountType,
      currency,
      accountNumber,
      idDocument,
    } = args.input

    if (level instanceof Error) {
      return { errors: [{ message: level.message }], success: false }
    }

    const result = await Accounts.businessAccountUpgradeRequest({
      accountId: domainAccount.id,
      level,
      fullName,
      phoneNumber: phoneNumber || undefined,
      email: email || undefined,
      businessName: businessName || undefined,
      businessAddress: businessAddress || undefined,
      terminalRequested: terminalRequested || undefined,
      bankName: bankName || undefined,
      bankBranch: bankBranch || undefined,
      accountType: accountType || undefined,
      currency: currency || undefined,
      accountNumber: accountNumber || undefined,
      idDocument: idDocument || undefined,
    })

    if (result instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(result)], success: false }
    }

    return {
      errors: [],
      success: true,
    }
  },
})

export default BusinessAccountUpgradeRequestMutation
