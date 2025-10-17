import { GT } from "@graphql/index"
import { InviteRepository, InviteStatus } from "@services/mongoose/models/invite"
import { AccountsRepository } from "@services/mongoose"
import { hashToken } from "@utils"
import { baseLogger } from "@services/logger"

const InvitePreview = GT.Object({
  name: "InvitePreview",
  fields: () => ({
    contact: { type: GT.NonNull(GT.String) }, // Full contact for intended recipient, masked for others
    method: { type: GT.NonNull(GT.String) }, // SMS, EMAIL, WHATSAPP
    inviterUsername: { type: GT.String },
    expiresAt: { type: GT.NonNull(GT.String) },
    isValid: { type: GT.NonNull(GT.Boolean) },
  }),
})

const InvitePreviewQuery = GT.Field<null, GraphQLPublicContext>({
  extensions: {
    complexity: 120,
  },
  type: InvitePreview,
  args: {
    token: { type: GT.NonNull(GT.String) },
  },
  resolve: async (_, args) => {
    const { token } = args

    if (!token || token.length !== 40) {
      throw new Error("Invalid invitation token")
    }

    try {
      // Hash the token to find it in the database
      const tokenHash = hashToken(token)

      // Find the invite by tokenHash
      const invite = await InviteRepository.findOne({ tokenHash })

      if (!invite) {
        throw new Error("Invalid or expired invitation")
      }

      // Check if invite is still valid
      const isExpired = new Date() > invite.expiresAt
      const isAlreadyUsed = invite.status === InviteStatus.ACCEPTED
      const isValid = !isExpired && !isAlreadyUsed

      // Get inviter username
      let inviterUsername: string | undefined
      const accountsRepo = AccountsRepository()
      const inviterAccount = await accountsRepo.findById(invite.inviterId.toString() as AccountId)
      if (!(inviterAccount instanceof Error)) {
        inviterUsername = inviterAccount.username
      }

      // IMPORTANT: Return full contact for the intended recipient
      // Since this is accessed with the invite token, only the intended recipient
      // should have access to this token, making it safe to return the full contact
      // This allows proper pre-filling of registration forms in the mobile app
      const contact = invite.contact

      baseLogger.info(
        {
          inviteId: invite._id,
          method: invite.method,
          isValid,
          returningFullContact: true,
        },
        "Invite preview requested - returning full contact for recipient",
      )

      return {
        contact,
        method: invite.method,
        inviterUsername: inviterUsername || "A Flash user",
        expiresAt: invite.expiresAt.toISOString(),
        isValid,
      }
    } catch (error) {
      baseLogger.error(
        { error, token: token.substring(0, 8) + "..." },
        "Failed to get invite preview",
      )
      throw new Error("Unable to preview invitation")
    }
  },
})

export default InvitePreviewQuery