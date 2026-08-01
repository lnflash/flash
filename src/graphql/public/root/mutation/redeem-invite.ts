import { GT } from "@graphql/index"
import { InviteRepository, InviteStatus } from "@services/mongoose/models/invite"
import { NEW_USER_INVITE_WINDOW_HOURS, checkedToInviteToken } from "@domain/invite"
import { hashToken } from "@utils"
import { baseLogger } from "@services/logger"
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

    // Validate token format
    const validatedToken = checkedToInviteToken(token)
    if (validatedToken instanceof Error) {
      return { success: false, errors: [validatedToken.message] }
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

      // Check if invite has already been accepted. This MUST precede the
      // date-expiry flip: replaying a redeemed invite's token after expiresAt
      // must not overwrite ACCEPTED with EXPIRED — that would strand the
      // pending reward and (via the one-redemption-per-account invariant)
      // permanently cost the account its referral.
      if (invite.status === InviteStatus.ACCEPTED) {
        return { success: false, errors: ["This invitation has already been used"] }
      }

      // Check if invite has expired
      if (new Date() > invite.expiresAt) {
        invite.status = InviteStatus.EXPIRED
        await invite.save()
        return { success: false, errors: ["This invitation has expired"] }
      }

      // Revoked (admin-expired) invites must not be redeemable even when their
      // expiresAt is still in the future.
      if (invite.status === InviteStatus.EXPIRED || invite.revokedAt) {
        return { success: false, errors: ["This invitation is no longer valid"] }
      }

      // Prevent self-redemption
      if (invite.inviterId.toString() === domainAccount.id) {
        return { success: false, errors: ["You cannot redeem your own invitation"] }
      }

      // One redeemed invite per account, ever: the referral reward is paid per
      // redeemed invite on KYC approval, so accumulating several accepted
      // invites would multiply payouts (KYC status flaps re-fire the award).
      const alreadyRedeemed = await InviteRepository.exists({
        redeemedById: new mongoose.Types.ObjectId(domainAccount.id),
        status: InviteStatus.ACCEPTED,
      })
      if (alreadyRedeemed) {
        return {
          success: false,
          errors: ["You have already redeemed an invitation"],
        }
      }

      // Check if user account is new (created within the invite window)
      const accountsRepo = AccountsRepository()
      const account = await accountsRepo.findById(domainAccount.id)
      if (account instanceof Error) {
        baseLogger.error(
          { error: account },
          "Failed to fetch account for invite validation",
        )
        return { success: false, errors: ["Failed to validate account"] }
      }

      const accountAge = Date.now() - account.createdAt.getTime()
      const inviteWindowMs = NEW_USER_INVITE_WINDOW_HOURS * 60 * 60 * 1000
      if (accountAge > inviteWindowMs) {
        baseLogger.info(
          {
            accountId: domainAccount.id,
            accountAge,
            inviteWindowHours: NEW_USER_INVITE_WINDOW_HOURS,
            inviteId: invite._id,
          },
          "Existing user attempted to redeem new user invite",
        )
        return { success: false, errors: ["This invitation is for new users only"] }
      }

      // Validate contact matches (phone or email)
      const usersRepo = UsersRepository()
      const userDetails = await usersRepo.findById(user.id)
      if (userDetails instanceof Error) {
        baseLogger.error(
          { error: userDetails },
          "Failed to fetch user for invite validation",
        )
        return { success: false, errors: ["Failed to validate user"] }
      }

      // Check if the invite contact matches user's phone or email
      const inviteContact = invite.contact.toLowerCase()
      const userPhone = userDetails.phone?.toLowerCase()

      if (invite.method === "SMS" || invite.method === "WHATSAPP") {
        if (!userPhone || userPhone !== inviteContact) {
          baseLogger.info(
            {
              inviteContact,
              userPhone,
              inviteMethod: invite.method,
            },
            "Phone number mismatch for invite redemption",
          )
          return {
            success: false,
            errors: ["This invitation was sent to a different phone number"],
          }
        }
      }
      // NOTE: Email validation is deferred until email-only registration is available.
      // Currently, users can only register with phone numbers, so email invites cannot
      // be validated against the redeemer's identity. Once the email-only registration
      // feature (feat/email-registration) is merged, this should be implemented to
      // verify that email invites are redeemed by the intended recipient.
      // See: https://github.com/lnflash/flash/pull/212
      //
      // else if (invite.method === "EMAIL") {
      //   const userEmail = userDetails.email?.toLowerCase()
      //   if (!userEmail || userEmail !== inviteContact) {
      //     return { success: false, errors: ["This invitation was sent to a different email address"] }
      //   }
      // }

      // Mark invite as accepted and set redeemer information. The unique
      // partial index on redeemedById backstops the check above: a concurrent
      // double-redeem loses with a duplicate-key error, treated as already
      // redeemed.
      invite.status = InviteStatus.ACCEPTED
      invite.redeemedAt = new Date()
      invite.redeemedById = new mongoose.Types.ObjectId(domainAccount.id)
      try {
        await invite.save()
      } catch (saveError) {
        if ((saveError as { code?: number })?.code === 11000) {
          return {
            success: false,
            errors: ["You have already redeemed an invitation"],
          }
        }
        throw saveError
      }

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

      // The referral reward is NOT paid here: payout is deferred until the
      // invitee's Bridge KYC is approved (awardReferralRewardOnKycApproval,
      // fired from the Bridge KYC webhook).

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
