import { GT } from "@graphql/index"
import { Admin } from "@app"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import InviteExtendPayload from "@graphql/admin/types/payload/invite-extend"
import Timestamp from "@graphql/shared/types/scalar/timestamp"

const InviteExtendInput = GT.Input({
  name: "InviteExtendInput",
  fields: () => ({
    inviteId: {
      type: GT.NonNullID,
    },
    newExpiresAt: {
      type: GT.NonNull(Timestamp),
    },
  }),
})

const InviteExtendMutation = GT.Field<
  null,
  GraphQLAdminContext,
  {
    input: {
      inviteId: string
      newExpiresAt: Date | Error
    }
  }
>({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(InviteExtendPayload),
  args: {
    input: { type: GT.NonNull(InviteExtendInput) },
  },
  resolve: async (_, args) => {
    const { inviteId, newExpiresAt } = args.input

    if (newExpiresAt instanceof Error) {
      return { errors: [{ message: newExpiresAt.message }] }
    }

    const invite = await Admin.extendInvite(inviteId, newExpiresAt)

    if (invite instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(invite)] }
    }

    return { errors: [], invite }
  },
})

export default InviteExtendMutation