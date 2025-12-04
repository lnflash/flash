/**
 * Business Account Upgrade Request GraphQL Mutation
 *
 * This mutation allows authenticated users to request an account level upgrade.
 * It creates a record in ERPNext's "Account Upgrade Request" doctype for admin review.
 *
 * The mutation collects user-provided information (fullName, business details, bank info)
 * and combines it with system data (username, phone, email) to create a complete request.
 */
import { Accounts } from "@app"

import { GT } from "@graphql/index"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import AccountLevel from "@graphql/shared/types/scalar/account-level"
import SuccessPayload from "@graphql/shared/types/payload/success-payload"

/**
 * GraphQL input type for business account upgrade requests
 *
 * Required fields:
 * - level: Target account level (TWO=Pro, THREE=Merchant)
 * - fullName: User's legal name for KYC verification
 *
 * Optional business/bank fields (for Merchant-level verification):
 * - businessName, businessAddress: Business registration details
 * - terminalRequested: Whether user needs a POS terminal
 * - bankName, bankBranch, accountType, currency, accountNumber: Settlement account
 * - idDocument: Reference to uploaded identification document
 *
 * Note: username, phone, and email are automatically fetched from the user's
 * account/identity records and do not need to be provided.
 */
const BusinessAccountUpgradeRequestInput = GT.Input({
  name: "BusinessAccountUpgradeRequestInput",
  fields: () => ({
    level: { type: GT.NonNull(AccountLevel) },
    fullName: { type: GT.NonNull(GT.String) },
    businessName: { type: GT.String },
    businessAddress: { type: GT.String },
    terminalRequested: { type: GT.Boolean },
    bankName: { type: GT.String },
    bankBranch: { type: GT.String },
    accountType: { type: GT.String },
    currency: { type: GT.String },
    accountNumber: { type: GT.Int },
    idDocument: { type: GT.String },
  }),
})

/**
 * Public GraphQL mutation for requesting business account upgrades.
 *
 * Users submit business details to request Pro (Level 2) or Merchant (Level 3) status.
 *
 * Behavior:
 * - Level 2 (Pro): Creates ERPNext Account Upgrade Request + auto-upgrades account immediately
 * - Level 3 (Merchant): Creates ERPNext Account Upgrade Request only, requires manual admin approval
 */
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
