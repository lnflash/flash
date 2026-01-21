import { InviteRepository } from "@services/mongoose/models/invite"
import {
  InviteStatus,
  InviteMethod,
  INVITE_EXPIRY_HOURS,
  validateContactForMethod,
} from "@domain/invite"
import { AccountsRepository } from "@services/mongoose"
import { UnknownRepositoryError } from "@domain/errors"
import { ValidationError } from "@domain/shared"
import { checkedToAccountId } from "@domain/accounts"
import { sendInviteNotification } from "@services/notifications/invite"
import { generateInviteToken } from "@utils"

import { checkInviteCreateRateLimit, checkInviteTargetRateLimit } from "./rate-limits"

export { getInviteById, listInvites } from "./queries"

export const createInvite = async ({
  accountId,
  contact,
  method,
}: {
  accountId: AccountId
  contact: string
  method: InviteMethod
}) => {
  try {
    // Validate contact format
    const contactValidation = validateContactForMethod(contact, method)
    if (contactValidation instanceof ValidationError) {
      return contactValidation
    }

    // Check rate limits
    const dailyLimitCheck = await checkInviteCreateRateLimit(accountId)
    if (dailyLimitCheck instanceof Error) {
      return new ValidationError("Daily invite limit exceeded")
    }

    const targetLimitCheck = await checkInviteTargetRateLimit(contact)
    if (targetLimitCheck instanceof Error) {
      return new ValidationError(
        "This contact has already been invited by multiple users",
      )
    }

    // Check for duplicate invite
    const existingInvite = await InviteRepository.findOne({
      inviterId: accountId,
      contact,
      status: { $in: [InviteStatus.PENDING, InviteStatus.SENT] },
    })
    if (existingInvite) {
      return new ValidationError("This contact has already been invited")
    }

    // Get inviter account for username
    const accounts = AccountsRepository()
    const inviterAccountId = checkedToAccountId(accountId)
    if (inviterAccountId instanceof Error) return inviterAccountId

    const inviterAccount = await accounts.findById(inviterAccountId)
    if (inviterAccount instanceof Error) return inviterAccount

    // Generate secure token (20 bytes = 40 hex chars)
    const { token, tokenHash } = generateInviteToken()

    // Create invite
    const expiresAt = new Date()
    expiresAt.setHours(expiresAt.getHours() + INVITE_EXPIRY_HOURS)

    const invite = new InviteRepository({
      contact,
      method,
      tokenHash,
      inviterId: accountId,
      status: InviteStatus.PENDING,
      createdAt: new Date(),
      expiresAt,
    })

    await invite.save()

    // Send notification with username
    const senderName = inviterAccount.username || "A friend"
    await sendInviteNotification({
      method,
      contact,
      token,
      senderName,
    })

    // Update status to SENT
    invite.status = InviteStatus.SENT
    await invite.save()

    return {
      id: invite._id.toString(),
      contact: invite.contact,
      method: invite.method,
      status: invite.status,
      createdAt: invite.createdAt,
      expiresAt: invite.expiresAt,
    }
  } catch (error) {
    return new UnknownRepositoryError(error)
  }
}
