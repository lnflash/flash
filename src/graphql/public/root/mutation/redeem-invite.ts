import { GT } from "@graphql/index"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import { Invite, InviteStatus } from "@services/mongoose/models/invite"
import { hashToken } from "@utils/hash"
import { baseLogger } from "@services/logger"
import SuccessPayload from "@graphql/shared/types/payload/success-payload"

const RedeemInviteInput = GT.Input({
  name: "RedeemInviteInput",
  fields: () => ({
    token: { type: GT.NonNull(GT.String) },
  }),
})

const RedeemInvitePayload = GT.Object({
  name: "RedeemInvitePayload",
  fields: () => ({
    success: { type: GT.NonNull(GT.Boolean) },
    errors: { type: GT.NonNull(GT.List(GT.NonNull(GT.String))) },
  }),
})

const RedeemInviteMutation = GT.Field<null, GraphQLPublicContext>({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(RedeemInvitePayload),
  args: {
    input: { type: GT.NonNull(RedeemInviteInput) },
  },
  resolve: async (_, args, { user }) => {
    const { token } = args.input

    if (!token || token.length !== 40) {
      return { success: false, errors: ["Invalid invitation token"] }
    }

    try {
      // Hash the token to find it in the database
      const tokenHash = hashToken(token)

      // Find the invite by tokenHash
      const invite = await Invite.findOne({ tokenHash })

      if (!invite) {
        return { success: false, errors: ["Invalid or expired invitation"] }
      }

      // Check if invite has expired
      if (new Date() > invite.expiresAt) {
        invite.status = InviteStatus.EXPIRED
        await invite.save()
        return { success: false, errors: ["This invitation has expired"] }
      }

      // Check if invite has already been accepted
      if (invite.status === InviteStatus.ACCEPTED) {
        return { success: false, errors: ["This invitation has already been used"] }
      }

      // Mark invite as accepted
      invite.status = InviteStatus.ACCEPTED
      await invite.save()

      // Log successful redemption
      baseLogger.info(
        { inviteId: invite._id, userId: user?.id },
        "Invite successfully redeemed"
      )

      // TODO: Additional logic for user creation or rewards can be added here
      // For example:
      // - If user is not logged in, redirect to signup with pre-filled invite info
      // - If user is logged in, apply any referral rewards
      // - Track analytics for the invitation

      return { 
        success: true, 
        errors: [] 
      }
    } catch (error) {
      baseLogger.error({ error, token: token.substring(0, 8) + "..." }, "Failed to redeem invite")
      const errorMessage = error instanceof Error ? error.message : "Unknown error occurred"
      return {
        success: false,
        errors: [errorMessage],
      }
    }
  },
})

export default RedeemInviteMutation