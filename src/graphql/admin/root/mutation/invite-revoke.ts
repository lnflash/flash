import { GT } from "@graphql/index"
import { Admin } from "@app"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import InviteRevokePayload from "@graphql/admin/types/payload/invite-revoke"
import { checkedToInviteId } from "@domain/invite"

const InviteRevokeInput = GT.Input({
  name: "InviteRevokeInput",
  fields: () => ({
    inviteId: {
      type: GT.NonNullID,
    },
    reason: {
      type: GT.String,
    },
  }),
})

const InviteRevokeMutation = GT.Field<
  null,
  GraphQLAdminContext,
  {
    input: {
      inviteId: string
      reason?: string
    }
  }
>({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(InviteRevokePayload),
  args: {
    input: { type: GT.NonNull(InviteRevokeInput) },
  },
  resolve: async (_, args) => {
    const { inviteId, reason } = args.input

    const checkedInviteId = checkedToInviteId(inviteId)
    if (checkedInviteId instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(checkedInviteId)] }
    }

    const invite = await Admin.revokeInvite(checkedInviteId, reason)

    if (invite instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(invite)] }
    }

    return { errors: [], invite }
  },
})

export default InviteRevokeMutation
