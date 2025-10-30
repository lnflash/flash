import { Accounts } from "@app"
import { GT } from "@graphql/index"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import AccountLevel from "@graphql/shared/types/scalar/account-level"

const AccountUpgradeRequestStatus = GT.Object({
  name: "AccountUpgradeRequestStatus",
  fields: () => ({
    hasPendingRequest: { type: GT.NonNull(GT.Boolean) },
    requestedLevel: { type: AccountLevel },
    errors: { type: GT.NonNull(GT.List(GT.NonNull(GT.String))) },
  }),
})

/**
 * Query to check if authenticated user has a pending account upgrade request
 */
const AccountUpgradeRequestStatusQuery = GT.Field({
  type: GT.NonNull(AccountUpgradeRequestStatus),
  resolve: async (_,__, { domainAccount }: { domainAccount: Account }) => {
    // Need username to query ERPNext
    if (!domainAccount.username) {
      return {
        hasPendingRequest: false,
        requestedLevel: null,
        errors: [],
      }
    }

    const result = await Accounts.hasPendingUpgradeRequest(domainAccount.username)

    if (result instanceof Error) {
      return {
        hasPendingRequest: false,
        requestedLevel: null,
        errors: [mapAndParseErrorForGqlResponse(result).message],
      }
    }

    return {
      hasPendingRequest: result.hasPending,
      requestedLevel: result.requestedLevel,
      errors: [],
    }
  },
})

export default AccountUpgradeRequestStatusQuery
