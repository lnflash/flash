import { Accounts } from "@app"

import { GT } from "@graphql/index"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import AccountLevel from "@graphql/shared/types/scalar/account-level"
import SuccessPayload from "@graphql/shared/types/payload/success-payload"

const BusinessAccountUpgradeRequestInput = GT.Input({
  name: "BusinessAccountUpgradeRequestInput",
  fields: () => ({
    level: { type: GT.NonNull(AccountLevel) },
    businessName: { type: GT.NonNull(GT.String) },
    businessType: { type: GT.NonNull(GT.String) },
    businessAddress: { type: GT.NonNull(GT.String) },
    businessPhone: { type: GT.NonNull(GT.String) },
    additionalInfo: { type: GT.String },
  }),
})

/**
 * Public GraphQL mutation for requesting business account upgrades.
 *
 * Users submit business details to request Pro (Level 2) or Merchant (Level 3) status.
 *
 * Behavior:
 * - Level 2 (Pro): Creates ERPNext Issue + auto-upgrades account immediately
 * - Level 3 (Merchant): Creates ERPNext Issue only, requires manual admin approval
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
    const { level, businessName, businessType, businessAddress, businessPhone, additionalInfo } = args.input

    if (level instanceof Error) {
      return { errors: [{ message: level.message }], success: false }
    }

    const result = await Accounts.businessAccountUpgradeRequest({
      accountId: domainAccount.id,
      level,
      businessName,
      businessType,
      businessAddress,
      businessPhone,
      additionalInfo: additionalInfo || undefined,
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
