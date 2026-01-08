import { Accounts } from "@app"
import { GT } from "@graphql/index"
import { mapError } from "@graphql/error-map"
import AccountUpgradeRequestPayload from "@graphql/public/types/payload/account-upgrade-request"

const AccountUpgradeRequestStatusQuery = GT.Field({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(AccountUpgradeRequestPayload),
  resolve: async (_, __, { domainAccount }: GraphQLPublicContextAuth) => {
    const username = domainAccount.username || domainAccount.id

    const result = await Accounts.getAccountUpgradeRequest(username)

    if (result instanceof Error) {
      return {
        errors: [mapError(result)],
        upgradeRequest: null,
      }
    }

    return {
      errors: [],
      upgradeRequest: result,
    }
  },
})

export default AccountUpgradeRequestStatusQuery
