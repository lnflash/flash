import crypto from "crypto"

import mongoose from "mongoose"
import { InviteRepository } from "@services/mongoose/models/invite"
import { InviteStatus, checkedToInviteToken, InviteToken } from "@domain/invite"
import { UnknownRepositoryError } from "@domain/errors"
import { ValidationError } from "@domain/shared"

export const redeemInvite = async ({
  accountId,
  token,
}: {
  accountId: AccountId
  token: string
}) => {
  try {
    // Validate token format
    const validatedToken = checkedToInviteToken(token)
    if (validatedToken instanceof Error) {
      return validatedToken
    }

    // Find invite by token hash
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex")
    const invite = await InviteRepository.findOne({ tokenHash })

    if (!invite) {
      return new ValidationError("Invalid invitation token")
    }

    // Check if already redeemed
    if (invite.status === InviteStatus.ACCEPTED) {
      return new ValidationError("This invitation has already been used")
    }

    // Check if expired
    if (invite.expiresAt < new Date()) {
      invite.status = InviteStatus.EXPIRED
      await invite.save()
      return new ValidationError("This invitation has expired")
    }

    // Prevent self-redemption
    if (invite.inviterId.toString() === accountId) {
      return new ValidationError("You cannot redeem your own invitation")
    }

    // Mark as redeemed
    invite.status = InviteStatus.ACCEPTED
    invite.redeemedAt = new Date()
    invite.redeemedById = new mongoose.Types.ObjectId(accountId)
    await invite.save()

    // TODO: Award rewards to both inviter and invitee
    // This would involve crediting their accounts through the ledger

    return true
  } catch (error) {
    return new UnknownRepositoryError(error)
  }
}
