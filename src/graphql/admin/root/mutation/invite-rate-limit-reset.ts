import { GT } from "@graphql/index"
import { Admin } from "@app"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import SuccessPayload from "@graphql/shared/types/payload/success-payload"
import { checkedToAccountId } from "@domain/accounts"

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

    const checkedAccountId = checkedToAccountId(accountId)
    if (checkedAccountId instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(checkedAccountId)] }
    }

    const result = await Admin.resetInviteRateLimit(checkedAccountId)

    if (result instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(result)] }
    }

    return { errors: [], success: true }
  },
})

export default InviteRateLimitResetMutation
