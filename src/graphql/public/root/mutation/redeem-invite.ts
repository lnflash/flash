import { GT } from "@graphql/index"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import { InviteRepository, InviteStatus } from "@services/mongoose/models/invite"
import { NEW_USER_INVITE_WINDOW_HOURS } from "@domain/invite"
import { hashToken } from "@utils"
import { baseLogger } from "@services/logger"
import SuccessPayload from "@graphql/shared/types/payload/success-payload"
import mongoose from "mongoose"
import { AccountsRepository, UsersRepository } from "@services/mongoose"

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

const RedeemInviteMutation = GT.Field<null, GraphQLPublicContextAuth>({
  extensions: {
    complexity: 120,
    auths: ["AUTHORIZED"],
  },
  type: GT.NonNull(RedeemInvitePayload),
  args: {
    input: { type: GT.NonNull(RedeemInviteInput) },
  },
  resolve: async (_, args, { user, domainAccount }) => {
    const { token } = args.input

    if (!token || token.length !== 40) {
      return { success: false, errors: ["Invalid invitation token"] }
    }

    // Ensure user is authenticated
    if (!user || !domainAccount) {
      return { success: false, errors: ["Authentication required to redeem invitation"] }
    }

    try {
      // Hash the token to find it in the database
      const tokenHash = hashToken(token)

      // Find the invite by tokenHash
      const invite = await InviteRepository.findOne({ tokenHash })

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

      // Prevent self-redemption
      if (invite.inviterId.toString() === domainAccount.id) {
        return { success: false, errors: ["You cannot redeem your own invitation"] }
      }

      // Check if user account is new (created within the invite window)
      const accountsRepo = AccountsRepository()
      const account = await accountsRepo.findById(domainAccount.id)
      if (account instanceof Error) {
        baseLogger.error({ error: account }, "Failed to fetch account for invite validation")
        return { success: false, errors: ["Failed to validate account"] }
      }

      const accountAge = Date.now() - account.createdAt.getTime()
      const inviteWindowMs = NEW_USER_INVITE_WINDOW_HOURS * 60 * 60 * 1000
      if (accountAge > inviteWindowMs) {
        baseLogger.info({
          accountId: domainAccount.id,
          accountAge,
          inviteWindowHours: NEW_USER_INVITE_WINDOW_HOURS,
          inviteId: invite._id
        }, "Existing user attempted to redeem new user invite")
        return { success: false, errors: ["This invitation is for new users only"] }
      }

      // Validate contact matches (phone or email)
      const usersRepo = UsersRepository()
      const userDetails = await usersRepo.findById(user.id)
      if (userDetails instanceof Error) {
        baseLogger.error({ error: userDetails }, "Failed to fetch user for invite validation")
        return { success: false, errors: ["Failed to validate user"] }
      }

      // Check if the invite contact matches user's phone or email
      const inviteContact = invite.contact.toLowerCase()
      const userPhone = userDetails.phone?.toLowerCase()
      // TODO: Add email check when email field is available
      // const userEmail = userDetails.email?.toLowerCase()

      if (invite.method === "SMS" || invite.method === "WHATSAPP") {
        if (!userPhone || userPhone !== inviteContact) {
          baseLogger.info({ 
            inviteContact,
            userPhone,
            inviteMethod: invite.method 
          }, "Phone number mismatch for invite redemption")
          return { success: false, errors: ["This invitation was sent to a different phone number"] }
        }
      }
      // TODO: Add email validation when email accounts are supported
      // else if (invite.method === "EMAIL") {
      //   if (!userEmail || userEmail !== inviteContact) {
      //     return { success: false, errors: ["This invitation was sent to a different email address"] }
      //   }
      // }

      // Mark invite as accepted and set redeemer information
      invite.status = InviteStatus.ACCEPTED
      invite.redeemedAt = new Date()
      invite.redeemedById = new mongoose.Types.ObjectId(domainAccount.id)
      await invite.save()

      // Log successful redemption
      baseLogger.info(
        { 
          inviteId: invite._id, 
          inviterId: invite.inviterId,
          redeemedById: domainAccount.id,
          redeemerUsername: domainAccount.username,
          contact: invite.contact,
          method: invite.method,
        },
        "Invite successfully redeemed by new user",
      )

      // TODO: Award rewards to both inviter and invitee
      // This would involve crediting their accounts through the ledger

      return {
        success: true,
        errors: [],
      }
    } catch (error) {
      baseLogger.error(
        { error, token: token.substring(0, 8) + "...", userId: user.id },
        "Failed to redeem invite",
      )
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error occurred"
      return {
        success: false,
        errors: [errorMessage],
      }
    }
  },
})

export default RedeemInviteMutation
