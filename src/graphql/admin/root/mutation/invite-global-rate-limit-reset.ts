import { GT } from "@graphql/index"
import { Admin } from "@app"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import SuccessPayload from "@graphql/shared/types/payload/success-payload"

const InviteGlobalRateLimitResetMutation = GT.Field<
  null,
  GraphQLAdminContext
>({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(SuccessPayload),
  resolve: async () => {
    const result = await Admin.resetAllInviteRateLimits()

    if (result instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(result)] }
    }

    return { errors: [], success: true }
  },
})

export default InviteGlobalRateLimitResetMutation