import { Accounts } from "@app"

import { GT } from "@graphql/index"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import AccountLevel from "@graphql/shared/types/scalar/account-level"
import SuccessPayload from "@graphql/shared/types/payload/success-payload"

const AccountLevelUpgradeRequestInput = GT.Input({
  name: "AccountLevelUpgradeRequestInput",
  fields: () => ({
    level: { type: GT.NonNull(AccountLevel) },
  }),
})

/**
 * Public GraphQL mutation for requesting account level upgrades.
 *
 * Allows authenticated users to request an upgrade to their account level (KYC level).
 * The request is stored and must be approved by an admin.
 *
 * This differs from the admin mutation which directly sets the account level.
 * This mutation only creates a request that requires admin approval.
 */
const AccountLevelUpgradeRequestMutation = GT.Field({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(SuccessPayload),
  args: {
    input: { type: GT.NonNull(AccountLevelUpgradeRequestInput) },
  },
  resolve: async (_, args, { domainAccount }: { domainAccount: Account }) => {
    const { level } = args.input

    if (level instanceof Error) {
      return { errors: [{ message: level.message }], success: false }
    }

    const result = await Accounts.requestAccountLevelUpgrade({
      accountId: domainAccount.id,
      level,
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

export default AccountLevelUpgradeRequestMutation
