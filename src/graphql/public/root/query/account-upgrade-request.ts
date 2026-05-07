import { Accounts } from "@app"
import { GT } from "@graphql/index"
import { apolloErrorResponse, mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import AccountUpgradeRequestPayload from "@graphql/public/types/payload/account-upgrade-request"
import { RequestStatus } from "@services/frappe/models/AccountUpgradeRequest"
import { UpgradeRequestQueryError } from "@services/frappe/errors"
import { InternalServerError, NotFoundError } from "@graphql/error"
import { SearchFilter } from "@services/frappe/SearchFilters"

const LatestAccountUpgradeRequestQuery = GT.Field({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(AccountUpgradeRequestPayload),
  resolve: async (_, __, { domainAccount }: GraphQLPublicContextAuth) => {
    const username = domainAccount.username || domainAccount.id

    const result = await Accounts.getAccountUpgradeRequests( 
      { 
        username: SearchFilter.Eq(username), 
        status: SearchFilter.In(RequestStatus.Approved, RequestStatus.Rejected, RequestStatus.Pending) 
      },
      1 
    )
    if (result instanceof UpgradeRequestQueryError) return apolloErrorResponse(new InternalServerError({ message: result.message }))
    if (result.length === 0) return apolloErrorResponse(new NotFoundError({ message: "No upgrade requests found for account." }))
    return { upgradeRequest: result[0] }
  },
})

export default LatestAccountUpgradeRequestQuery
