import { Invite } from "@services/mongoose/models/invite"
import { InviteStatus } from "@domain/invite"
import { UnknownRepositoryError } from "@domain/errors"

export const updateInviteToken = async (inviteId: string, token: string) => {
  try {
    const invite = await Invite.findById(inviteId)
    if (!invite) {
      return new UnknownRepositoryError(`Invite ${inviteId} not found`)
    }
    
    // Store the token hash
    const crypto = require("crypto")
    invite.tokenHash = crypto.createHash("sha256").update(token).digest("hex")
    await invite.save()
    
    return true
  } catch (error) {
    return new UnknownRepositoryError(error)
  }
}

export const findInviteByToken = async (token: string) => {
  try {
    const crypto = require("crypto")
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex")
    
    const invite = await Invite.findOne({ tokenHash })
    if (!invite) {
      return null
    }
    
    return invite
  } catch (error) {
    return new UnknownRepositoryError(error)
  }
}

export const markInviteAsRedeemed = async (inviteId: string, redeemedById: string) => {
  try {
    const invite = await Invite.findById(inviteId)
    if (!invite) {
      return new UnknownRepositoryError(`Invite ${inviteId} not found`)
    }
    
    invite.status = InviteStatus.ACCEPTED
    invite.redeemedAt = new Date()
    invite.redeemedById = redeemedById as any
    await invite.save()
    
    return true
  } catch (error) {
    return new UnknownRepositoryError(error)
  }
}