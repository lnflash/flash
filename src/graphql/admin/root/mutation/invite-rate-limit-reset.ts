import { GT } from "@graphql/index"
import { Admin } from "@app"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import SuccessPayload from "@graphql/shared/types/payload/success-payload"

const InviteRateLimitResetInput = GT.Input({
  name: "InviteRateLimitResetInput",
  fields: () => ({
    accountId: {
      type: GT.NonNullID,
    },
  }),
})

const InviteRateLimitResetMutation = GT.Field<
  null,
  GraphQLAdminContext,
  {
    input: {
      accountId: string
    }
  }
>({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(SuccessPayload),
  args: {
    input: { type: GT.NonNull(InviteRateLimitResetInput) },
  },
  resolve: async (_, args) => {
    const { accountId } = args.input

    const result = await Admin.resetInviteRateLimit(accountId)

    if (result instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(result)] }
    }

    return { errors: [], success: true }
  },
})

export default InviteRateLimitResetMutation