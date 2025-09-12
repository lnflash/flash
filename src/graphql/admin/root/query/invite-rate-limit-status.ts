import { GT } from "@graphql/index"
import { Admin } from "@app"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import IError from "@graphql/shared/types/abstract/error"

const InviteRateLimitStatusInput = GT.Input({
  name: "InviteRateLimitStatusInput",
  fields: () => ({
    accountId: {
      type: GT.String,
    },
    contact: {
      type: GT.String,
    },
  }),
})

const InviteRateLimitStatus = GT.Object({
  name: "InviteRateLimitStatus",
  fields: () => ({
    accountId: { type: GT.String },
    contact: { type: GT.String },
    dailyCount: { type: GT.Int },
    dailyLimit: { type: GT.Int },
    targetCount: { type: GT.Int },
    targetLimit: { type: GT.Int },
    dailyTtl: { type: GT.Int },
    targetTtl: { type: GT.Int },
  }),
})

const InviteRateLimitStatusPayload = GT.Object({
  name: "InviteRateLimitStatusPayload",
  fields: () => ({
    status: { type: InviteRateLimitStatus },
    errors: { type: GT.NonNullList(IError) },
  }),
})

const InviteRateLimitStatusQuery = GT.Field<
  null,
  GraphQLAdminContext,
  {
    input?: {
      accountId?: string
      contact?: string
    }
  }
>({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(InviteRateLimitStatusPayload),
  args: {
    input: { type: InviteRateLimitStatusInput },
  },
  resolve: async (_, args) => {
    const result = await Admin.getInviteRateLimitStatus(args.input || {})

    if (result instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(result)], status: null }
    }

    return { errors: [], status: result }
  },
})

export default InviteRateLimitStatusQuery