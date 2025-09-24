import { Accounts } from "@app"

import { GT } from "@graphql/index"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import AccountLevel from "@graphql/shared/types/scalar/account-level"
import AccountUpdateLevelPayload from "@graphql/public/types/payload/account-update-level"

const AccountUpdateLevelInput = GT.Input({
  name: "AccountUpdateLevelInput",
  fields: () => ({
    level: { type: GT.NonNull(AccountLevel) },
  }),
})

/**
 * Public GraphQL mutation for self-service account level upgrades.
 *
 * Allows authenticated users to upgrade their account level (KYC level)
 * if they have been validated by an admin. The validation flag is
 * single-use and resets after each upgrade.
 *
 * This differs from the admin mutation which can set any account to any level.
 * This mutation only allows upgrades (not downgrades) and requires validation.
 */
const AccountUpdateLevelMutation = GT.Field({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(AccountUpdateLevelPayload),
  args: {
    input: { type: GT.NonNull(AccountUpdateLevelInput) },
  },
  resolve: async (_, args, { domainAccount }: { domainAccount: Account }) => {
    const { level } = args.input

    if (level instanceof Error) {
      return { errors: [{ message: level.message }] }
    }

    const result = await Accounts.selfUpgradeAccountLevel({
      accountId: domainAccount.id,
      level,
    })

    if (result instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(result)] }
    }

    return {
      errors: [],
      account: result,
    }
  },
})

export default AccountUpdateLevelMutation