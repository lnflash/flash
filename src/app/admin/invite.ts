import { InviteRepository } from "@services/mongoose/models/invite"
import {
  InviteStatus,
  InviteId,
  InviteAlreadyAcceptedError,
  InvalidExpirationDateError,
  DAILY_INVITE_LIMIT,
  TARGET_INVITE_LIMIT,
} from "@domain/invite"
import { RateLimitPrefix } from "@domain/rate-limit"
import { redis } from "@services/redis"
import { UnknownRepositoryError, CouldNotFindError } from "@domain/errors"

export const revokeInvite = async (inviteId: InviteId, reason?: string) => {
  try {
    const invite = await InviteRepository.findById(inviteId)
    if (!invite) {
      return new CouldNotFindError(`Invite not found: ${inviteId}`)
    }

    if (invite.status === InviteStatus.ACCEPTED) {
      return new InviteAlreadyAcceptedError("Cannot revoke an already accepted invite")
    }

    invite.status = InviteStatus.EXPIRED
    invite.revokedAt = new Date()
    invite.revokeReason = reason
    await invite.save()

    return {
      id: invite._id.toString(),
      contact: invite.contact,
      method: invite.method,
      status: invite.status,
      inviterAccountId: invite.inviterId.toString(),
      createdAt: invite.createdAt,
      expiresAt: invite.expiresAt,
    }
  } catch (error) {
    return new UnknownRepositoryError(error)
  }
}

export const extendInvite = async (inviteId: InviteId, newExpiresAt: Date) => {
  try {
    const invite = await InviteRepository.findById(inviteId)
    if (!invite) {
      return new CouldNotFindError(`Invite not found: ${inviteId}`)
    }

    if (invite.status === InviteStatus.ACCEPTED) {
      return new InviteAlreadyAcceptedError("Cannot extend an already accepted invite")
    }

    // Validate new expiration is in the future
    if (newExpiresAt <= new Date()) {
      return new InvalidExpirationDateError("New expiration date must be in the future")
    }

    invite.expiresAt = newExpiresAt
    invite.status = InviteStatus.PENDING // Reset status if it was expired
    await invite.save()

    return {
      id: invite._id.toString(),
      contact: invite.contact,
      method: invite.method,
      status: invite.status,
      inviterAccountId: invite.inviterId.toString(),
      createdAt: invite.createdAt,
      expiresAt: invite.expiresAt,
    }
  } catch (error) {
    return new UnknownRepositoryError(error)
  }
}

export const resetInviteRateLimit = async (accountId: AccountId) => {
  try {
    // Clear the rate limit key for this account (matches rate-limiter-flexible key format)
    const dailyKey = `${RateLimitPrefix.inviteCreate}:${accountId}`

    // Delete the daily limit key
    await redis.del(dailyKey)

    return true
  } catch (error) {
    return new UnknownRepositoryError(error)
  }
}

export const resetInviteTargetRateLimit = async (contact: string) => {
  try {
    // Clear the target rate limit key for this contact (matches rate-limiter-flexible key format)
    const targetKey = `${RateLimitPrefix.inviteTarget}:${contact}`

    // Delete the target limit key
    await redis.del(targetKey)

    return true
  } catch (error) {
    return new UnknownRepositoryError(error)
  }
}

export const resetAllInviteRateLimits = async () => {
  try {
    // Use SCAN instead of KEYS for production safety
    // Match the rate-limiter-flexible key format
    const patterns = [
      `${RateLimitPrefix.inviteCreate}:*`,
      `${RateLimitPrefix.inviteTarget}:*`,
    ]
    const allKeys: string[] = []

    for (const pattern of patterns) {
      let cursor = "0"
      do {
        const result = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100)
        cursor = result[0]
        const keys = result[1]
        allKeys.push(...keys)
      } while (cursor !== "0")
    }

    if (allKeys.length > 0) {
      // Delete in batches of 100 to avoid overloading Redis
      const batchSize = 100
      for (let i = 0; i < allKeys.length; i += batchSize) {
        const batch = allKeys.slice(i, i + batchSize)
        await redis.del(...batch)
      }
    }

    return true
  } catch (error) {
    return new UnknownRepositoryError(error)
  }
}

export const getInviteRateLimitStatus = async ({
  accountId,
  contact,
}: {
  accountId?: AccountId
  contact?: string
}) => {
  try {
    let dailyCount: number | null = null
    let dailyTtl: number | null = null
    let targetCount: number | null = null
    let targetTtl: number | null = null

    if (accountId) {
      const dailyKey = `${RateLimitPrefix.inviteCreate}:${accountId}`
      const count = await redis.get(dailyKey)
      dailyCount = count ? parseInt(count) : 0
      const ttl = await redis.ttl(dailyKey)
      dailyTtl = ttl > 0 ? ttl : null
    }

    if (contact) {
      const targetKey = `${RateLimitPrefix.inviteTarget}:${contact}`
      const count = await redis.get(targetKey)
      targetCount = count ? parseInt(count) : 0
      const ttl = await redis.ttl(targetKey)
      targetTtl = ttl > 0 ? ttl : null
    }

    return {
      accountId,
      contact,
      dailyCount,
      dailyLimit: DAILY_INVITE_LIMIT,
      targetCount,
      targetLimit: TARGET_INVITE_LIMIT,
      dailyTtl,
      targetTtl,
    }
  } catch (error) {
    return new UnknownRepositoryError(error)
  }
}
