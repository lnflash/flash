import { Accounts } from "@app"
import { GT } from "@graphql/index"
import { apolloErrorResponse, mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import AccountUpgradeRequestPayload from "@graphql/public/types/payload/account-upgrade-request"
import { RequestStatus } from "@services/frappe/models/AccountUpgradeRequest"
import { UpgradeRequestQueryError } from "@services/frappe/errors"
import { InternalServerError, NotFoundError } from "@graphql/error"

const AccountUpgradeRequestQuery = GT.Field({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(AccountUpgradeRequestPayload),
  resolve: async (_, __, { domainAccount }: GraphQLPublicContextAuth) => {
    const username = domainAccount.username || domainAccount.id

    const result = await Accounts.getAccountUpgradeRequests({ 
      username, 
      status: RequestStatus.Pending, 
      count: 1 
    })
    if (result instanceof UpgradeRequestQueryError) return apolloErrorResponse(new InternalServerError({ message: result.message }))
    if (result.length === 0) return apolloErrorResponse(new NotFoundError({ message: "No pending Upgrade Requests found for account." }))
    return { upgradeRequest: result[0] }
  },
})

export default AccountUpgradeRequestQuery
