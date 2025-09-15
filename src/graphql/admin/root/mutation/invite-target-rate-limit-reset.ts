import { GT } from "@graphql/index"
import { Admin } from "@app"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import SuccessPayload from "@graphql/shared/types/payload/success-payload"

const InviteTargetRateLimitResetInput = GT.Input({
  name: "InviteTargetRateLimitResetInput",
  fields: () => ({
    contact: {
      type: GT.NonNull(GT.String),
    },
  }),
})

const InviteTargetRateLimitResetMutation = GT.Field<
  null,
  GraphQLAdminContext,
  {
    input: {
      contact: string
    }
  }
>({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(SuccessPayload),
  args: {
    input: { type: GT.NonNull(InviteTargetRateLimitResetInput) },
  },
  resolve: async (_, args) => {
    const { contact } = args.input

    const result = await Admin.resetInviteTargetRateLimit(contact)

    if (result instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(result)] }
    }

    return { errors: [], success: true }
  },
})

export default InviteTargetRateLimitResetMutation