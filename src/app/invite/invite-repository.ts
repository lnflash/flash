import crypto from "crypto"

import mongoose from "mongoose"
import { InviteRepository } from "@services/mongoose/models/invite"
import { InviteStatus, InviteId } from "@domain/invite"
import { UnknownRepositoryError } from "@domain/errors"

export const updateInviteToken = async (inviteId: InviteId, token: string) => {
  try {
    const invite = await InviteRepository.findById(inviteId)
    if (!invite) {
      return new UnknownRepositoryError(`Invite ${inviteId} not found`)
    }

    // Store the token hash
    invite.tokenHash = crypto.createHash("sha256").update(token).digest("hex")
    await invite.save()

    return true
  } catch (error) {
    return new UnknownRepositoryError(error)
  }
}

export const findInviteByToken = async (token: string) => {
  try {
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex")

    const invite = await InviteRepository.findOne({ tokenHash })
    if (!invite) {
      return null
    }

    return invite
  } catch (error) {
    return new UnknownRepositoryError(error)
  }
}

export const markInviteAsRedeemed = async (
  inviteId: InviteId,
  redeemedById: AccountId,
) => {
  try {
    const invite = await InviteRepository.findById(inviteId)
    if (!invite) {
      return new UnknownRepositoryError(`Invite ${inviteId} not found`)
    }

    invite.status = InviteStatus.ACCEPTED
    invite.redeemedAt = new Date()
    invite.redeemedById = new mongoose.Types.ObjectId(redeemedById)
    await invite.save()

    return true
  } catch (error) {
    return new UnknownRepositoryError(error)
  }
}
