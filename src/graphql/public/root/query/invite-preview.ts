import { GT } from "@graphql/index"
import { InviteRepository, InviteStatus } from "@services/mongoose/models/invite"
import { AccountsRepository } from "@services/mongoose"
import { hashToken } from "@utils"
import { baseLogger } from "@services/logger"

const InvitePreview = GT.Object({
  name: "InvitePreview",
  fields: () => ({
    contact: { type: GT.NonNull(GT.String) }, // Masked contact
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

      // Mask the contact for privacy
      const maskedContact = maskContact(invite.contact, invite.method)

      baseLogger.info(
        { 
          inviteId: invite._id,
          method: invite.method,
          isValid,
        },
        "Invite preview requested",
      )

      return {
        contact: maskedContact,
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

// Helper function to mask contact information
function maskContact(contact: string, method: string): string {
  if (method === "EMAIL") {
    // Mask email: john.doe@example.com -> j***@example.com
    const [localPart, domain] = contact.split("@")
    if (!domain) return "***@***"
    
    const firstChar = localPart[0] || ""
    return `${firstChar}***@${domain}`
  } else {
    // Mask phone: +16505554334 -> +1650****334
    if (contact.length < 7) return "****"
    
    const firstPart = contact.substring(0, contact.length - 6)
    const lastPart = contact.substring(contact.length - 3)
    return `${firstPart}***${lastPart}`
  }
}

export default InvitePreviewQuery