import { Invite } from "@services/mongoose/models/invite"
import { InviteStatus, InviteMethod, INVITE_EXPIRY_HOURS, DAILY_INVITE_LIMIT, TARGET_INVITE_LIMIT } from "@domain/invite"
import { AccountsRepository } from "@services/mongoose"
import { redis } from "@services/redis"
import { UnknownRepositoryError } from "@domain/errors"
import { ValidationError } from "@domain/shared"
import { checkedToAccountId } from "@domain/accounts"
import { sendInviteNotification } from "@services/notifications/invite"
import crypto from "crypto"

const validateEmail = (email: string): boolean => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  return emailRegex.test(email)
}

const validatePhone = (phone: string): boolean => {
  const phoneRegex = /^\+[1-9]\d{7,14}$/
  return phoneRegex.test(phone)
}

export const createInvite = async ({
  accountId,
  contact,
  method,
}: {
  accountId: string
  contact: string
  method: InviteMethod
}) => {
  try {
    // Validate contact format
    if (method === InviteMethod.EMAIL && !validateEmail(contact)) {
      return new ValidationError("Invalid email format")
    }
    if ((method === InviteMethod.SMS || method === InviteMethod.WHATSAPP) && !validatePhone(contact)) {
      return new ValidationError("Invalid phone number format")
    }

    // Check rate limits
    const dailyKey = `invite:daily:${accountId}`
    const targetKey = `invite:target:${contact}`
    
    // Check current counts before incrementing
    const currentDailyCount = await redis.get(dailyKey)
    if (currentDailyCount && parseInt(currentDailyCount) >= DAILY_INVITE_LIMIT) {
      return new ValidationError(`Daily invite limit (${DAILY_INVITE_LIMIT}) exceeded`)
    }
    
    const currentTargetCount = await redis.get(targetKey)
    if (currentTargetCount && parseInt(currentTargetCount) >= TARGET_INVITE_LIMIT) {
      return new ValidationError(`This contact has already been invited by multiple users`)
    }
    
    // Now increment the counters
    const dailyCount = await redis.incr(dailyKey)
    if (dailyCount === 1) {
      await redis.expire(dailyKey, 86400) // 24 hours
    }
    
    const targetCount = await redis.incr(targetKey)
    if (targetCount === 1) {
      await redis.expire(targetKey, 86400) // 24 hours
    }

    // Check for duplicate invite
    const existingInvite = await Invite.findOne({
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

    // Generate secure token
    const token = crypto.randomBytes(32).toString("hex")
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex")

    // Create invite
    const expiresAt = new Date()
    expiresAt.setHours(expiresAt.getHours() + INVITE_EXPIRY_HOURS)
    
    const invite = new Invite({
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