import { GT } from "@graphql/index"
import { InviteMethod, InviteStatus } from "@services/mongoose/models/invite"
import { createInvite } from "@app/invite"
import { baseLogger } from "@services/logger"
import { checkedToAccountId } from "@domain/accounts"

const InviteMethodEnum = GT.Enum({
  name: "InviteMethod",
  values: {
    EMAIL: { value: InviteMethod.EMAIL },
    SMS: { value: InviteMethod.SMS },
    WHATSAPP: { value: InviteMethod.WHATSAPP },
  },
})

const InviteStatusEnum = GT.Enum({
  name: "InviteStatus",
  values: {
    PENDING: { value: InviteStatus.PENDING },
    SENT: { value: InviteStatus.SENT },
    ACCEPTED: { value: InviteStatus.ACCEPTED },
    EXPIRED: { value: InviteStatus.EXPIRED },
  },
})

const InviteType = GT.Object({
  name: "Invite",
  fields: () => ({
    id: { type: GT.NonNull(GT.ID) },
    contact: { type: GT.NonNull(GT.String) },
    method: { type: GT.NonNull(InviteMethodEnum) },
    status: { type: GT.NonNull(InviteStatusEnum) },
    createdAt: { type: GT.NonNull(GT.String) },
    expiresAt: { type: GT.NonNull(GT.String) },
  }),
})

const CreateInviteInput = GT.Input({
  name: "CreateInviteInput",
  fields: () => ({
    contact: { type: GT.NonNull(GT.String) },
    method: { type: GT.NonNull(InviteMethodEnum) },
  }),
})

const CreateInvitePayload = GT.Object({
  name: "CreateInvitePayload",
  fields: () => ({
    invite: { type: InviteType },
    errors: { type: GT.NonNull(GT.List(GT.NonNull(GT.String))) },
  }),
})

const CreateInviteMutation = GT.Field<null, GraphQLPublicContextAuth>({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(CreateInvitePayload),
  args: {
    input: { type: GT.NonNull(CreateInviteInput) },
  },
  resolve: async (_, args, { domainAccount }) => {
    const { contact, method } = args.input

    if (!domainAccount) {
      return { errors: ["Authentication required"], invite: null }
    }

    try {
      const accountId = checkedToAccountId(domainAccount.id)
      if (accountId instanceof Error) {
        return { errors: [accountId.message], invite: null }
      }

      const result = await createInvite({
        accountId,
        contact,
        method,
      })

      if (result instanceof Error) {
        return { errors: [result.message], invite: null }
      }

      return {
        errors: [],
        invite: {
          id: result.id,
          contact: result.contact,
          method: result.method,
          status: result.status,
          createdAt: result.createdAt.toISOString(),
          expiresAt: result.expiresAt.toISOString(),
        },
      }
    } catch (error) {
      baseLogger.error({ error }, "Failed to create invite")
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error occurred"
      return {
        errors: [errorMessage],
        invite: null,
      }
    }
  },
})

export default CreateInviteMutation
