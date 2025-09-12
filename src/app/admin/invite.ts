import { Invite } from "@services/mongoose/models/invite"
import { AccountsRepository } from "@services/mongoose"
import { InviteStatus, InviteMethod } from "@domain/invite"
import { redis } from "@services/redis"
import { UnknownRepositoryError, CouldNotFindError } from "@domain/errors"
import { checkedToAccountId } from "@domain/accounts"

export const getInviteById = async (id: string) => {
  try {
    const invite = await Invite.findById(id)
    if (!invite) {
      return new CouldNotFindError(`Invite not found: ${id}`)
    }

    // Get inviter account details
    const accounts = AccountsRepository()
    const inviterAccountId = checkedToAccountId(invite.inviterId.toString())
    if (inviterAccountId instanceof Error) return inviterAccountId
    
    const inviterAccount = await accounts.findById(inviterAccountId)
    if (inviterAccount instanceof Error) return inviterAccount

    // Get redeemer account if invite was redeemed
    let redeemerAccountId: string | undefined
    let redeemerUsername: string | undefined
    if (invite.status === InviteStatus.ACCEPTED && invite.redeemedById) {
      const redeemerAccId = checkedToAccountId(invite.redeemedById.toString())
      if (!(redeemerAccId instanceof Error)) {
        const account = await accounts.findById(redeemerAccId)
        if (!(account instanceof Error)) {
          redeemerAccountId = account.id
          redeemerUsername = account.username || undefined
        }
      }
    }

    return {
      id: invite._id.toString(),
      contact: invite.contact,
      method: invite.method,
      status: invite.status,
      inviterAccountId: invite.inviterId.toString(),
      inviterUsername: inviterAccount.username,
      redeemerAccountId,
      redeemerUsername,
      createdAt: invite.createdAt,
      expiresAt: invite.expiresAt,
      redeemedAt: invite.redeemedAt,
    }
  } catch (error) {
    return new UnknownRepositoryError(error)
  }
}

export const listInvites = async ({
  first = 20,
  after,
  status,
  inviterId,
}: {
  first?: number
  after?: string | null
  status?: InviteStatus
  inviterId?: string
}) => {
  try {
    const query: any = {}
    
    if (status) {
      query.status = status
    }
    
    if (inviterId) {
      query.inviterId = inviterId
    }

    if (after) {
      // Decode cursor (it's a base64 encoded timestamp)
      const timestamp = Buffer.from(after, "base64").toString()
      query.createdAt = { $lt: new Date(timestamp) }
    }

    const invites = await Invite.find(query)
      .sort({ createdAt: -1 })
      .limit(first + 1) // Get one extra to determine if there's a next page
      .lean()

    const hasNextPage = invites.length > first
    const edges = invites.slice(0, first).map((invite) => ({
      cursor: Buffer.from(invite.createdAt.toISOString()).toString("base64"),
      node: {
        id: invite._id.toString(),
        contact: invite.contact,
        method: invite.method,
        status: invite.status,
        inviterAccountId: invite.inviterId.toString(),
        createdAt: invite.createdAt,
        expiresAt: invite.expiresAt,
      },
    }))

    return {
      edges,
      pageInfo: {
        hasNextPage,
        hasPreviousPage: !!after,
        startCursor: edges[0]?.cursor || null,
        endCursor: edges[edges.length - 1]?.cursor || null,
      },
    }
  } catch (error) {
    return new UnknownRepositoryError(error)
  }
}

export const getInviteStatistics = async () => {
  try {
    const [totalSent, totalRedeemed, totalPending] = await Promise.all([
      Invite.countDocuments(),
      Invite.countDocuments({ status: InviteStatus.ACCEPTED }),
      Invite.countDocuments({ status: { $in: [InviteStatus.PENDING, InviteStatus.SENT] } }),
    ])

    const redemptionRate = totalSent > 0 ? (totalRedeemed / totalSent) : 0

    return {
      totalSent,
      totalRedeemed,
      totalPending,
      redemptionRate,
    }
  } catch (error) {
    return new UnknownRepositoryError(error)
  }
}

export const revokeInvite = async (inviteId: string, reason?: string) => {
  try {
    const invite = await Invite.findById(inviteId)
    if (!invite) {
      return new CouldNotFindError(`Invite not found: ${inviteId}`)
    }

    if (invite.status === InviteStatus.ACCEPTED) {
      return new Error("Cannot revoke an already accepted invite")
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

export const extendInvite = async (inviteId: string, newExpiresAt: Date) => {
  try {
    const invite = await Invite.findById(inviteId)
    if (!invite) {
      return new CouldNotFindError(`Invite not found: ${inviteId}`)
    }

    if (invite.status === InviteStatus.ACCEPTED) {
      return new Error("Cannot extend an already accepted invite")
    }

    // Validate new expiration is in the future
    if (newExpiresAt <= new Date()) {
      return new Error("New expiration date must be in the future")
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

export const resetInviteRateLimit = async (accountId: string) => {
  try {
    // Clear all rate limit keys for this account
    const dailyKey = `invite:daily:${accountId}`
    
    // Delete the daily limit key
    await redis.del(dailyKey)
    
    return true
  } catch (error) {
    return new UnknownRepositoryError(error)
  }
}

export const resetInviteTargetRateLimit = async (contact: string) => {
  try {
    // Clear the target rate limit key for this contact
    const targetKey = `invite:target:${contact}`
    
    // Delete the target limit key
    await redis.del(targetKey)
    
    return true
  } catch (error) {
    return new UnknownRepositoryError(error)
  }
}

export const resetAllInviteRateLimits = async () => {
  try {
    // Get all invite-related rate limit keys (both old and new patterns)
    const dailyKeys = await redis.keys(`invite:daily:*`)
    const targetKeys = await redis.keys(`invite:target:*`)
    const oldRateLimitKeys = await redis.keys(`invite:ratelimit:*`)
    
    // Delete all keys in batches
    const allKeys = [...dailyKeys, ...targetKeys, ...oldRateLimitKeys]
    
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

export const getInviteRateLimitStatus = async ({ accountId, contact }: { accountId?: string, contact?: string }) => {
  try {
    const DAILY_INVITE_LIMIT = 10
    const TARGET_INVITE_LIMIT = 3
    
    let dailyCount: number | null = null
    let dailyTtl: number | null = null
    let targetCount: number | null = null
    let targetTtl: number | null = null
    
    if (accountId) {
      const dailyKey = `invite:daily:${accountId}`
      const count = await redis.get(dailyKey)
      dailyCount = count ? parseInt(count) : 0
      const ttl = await redis.ttl(dailyKey)
      dailyTtl = ttl > 0 ? ttl : null
    }
    
    if (contact) {
      const targetKey = `invite:target:${contact}`
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