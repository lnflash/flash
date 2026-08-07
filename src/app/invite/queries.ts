import mongoose from "mongoose"

import { isValidObjectId } from "@services/mongoose/utils"

import { InviteRepository } from "@services/mongoose/models/invite"
import { AccountsRepository } from "@services/mongoose"
import { InviteStatus, InviteId } from "@domain/invite"
import {
  UnknownRepositoryError,
  CouldNotFindError,
  BadInputsForFindError,
} from "@domain/errors"
import { checkedToAccountId } from "@domain/accounts"

export const getInviteById = async (id: InviteId) => {
  try {
    const invite = await InviteRepository.findById(id)
    if (!invite) {
      return new CouldNotFindError(`Invite not found: ${id}`)
    }

    // Get inviter account details
    const inviterAccountId = checkedToAccountId(invite.inviterId.toString())
    if (inviterAccountId instanceof Error) return inviterAccountId

    const inviterAccount = await AccountsRepository().findById(inviterAccountId)
    if (inviterAccount instanceof Error) return inviterAccount

    // Get redeemer account if invite was redeemed
    let redeemerAccountId: string | undefined
    let redeemerUsername: string | undefined
    if (invite.status === InviteStatus.ACCEPTED && invite.redeemedById) {
      const redeemerAccId = checkedToAccountId(invite.redeemedById.toString())
      if (!(redeemerAccId instanceof Error)) {
        const account = await AccountsRepository().findById(redeemerAccId)
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
      rewardStatus: invite.rewardStatus,
      rewardAmountCents: invite.rewardAmountCents,
      rewardedAt: invite.rewardedAt,
    }
  } catch (error) {
    return new UnknownRepositoryError(error)
  }
}

export const listInvites = async ({
  first = 20,
  afterId,
  status,
  inviterId,
}: {
  first?: number
  // _id cursor: return invites strictly older than this id (ObjectIds are
  // time-ordered, matching the newest-first sort).
  afterId?: string
  status?: InviteStatus
  inviterId?: AccountId
}) => {
  if (afterId && !isValidObjectId(afterId)) {
    // Bad client input, not a repository failure — never let a garbage cursor
    // masquerade as an unknown 500.
    return new BadInputsForFindError(`invalid afterId cursor: ${afterId}`)
  }

  try {
    const matchQuery: Record<string, unknown> = {}

    if (status) {
      matchQuery.status = status
    }

    if (inviterId) {
      // mongoose does not cast inside aggregation pipelines — a raw string
      // would silently match nothing against the ObjectId field.
      matchQuery.inviterId = new mongoose.Types.ObjectId(inviterId)
    }

    const cursorMatch = afterId
      ? [{ $match: { _id: { $lt: new mongoose.Types.ObjectId(afterId) } } }]
      : []

    const [result] = await InviteRepository.aggregate([
      { $match: matchQuery },
      {
        $facet: {
          // count covers everything matching the filter; only the data page
          // is cursor-restricted.
          data: [
            ...cursorMatch,
            { $sort: { _id: -1 } },
            { $limit: first },
            {
              $project: {
                id: { $toString: "$_id" },
                contact: 1,
                method: 1,
                status: 1,
                inviterAccountId: { $toString: "$inviterId" },
                createdAt: 1,
                expiresAt: 1,
                redeemedAt: 1,
                rewardStatus: 1,
                rewardAmountCents: 1,
                rewardedAt: 1,
                inviterRewardedAt: 1,
              },
            },
          ],
          count: [{ $count: "total" }],
        },
      },
    ])

    return {
      data: result.data || [],
      count: result.count || [{ total: 0 }],
    }
  } catch (error) {
    return new UnknownRepositoryError(error)
  }
}

// Aggregate the caller's referral picture in one pass. "Earned" is strictly
// the inviter's own leg (inviterRewardedAt set); a reward is "pending" from
// the inviter's point of view whenever the invite was redeemed but their leg
// hasn't paid yet — internal failed/processing states are ops' problem, the
// user just sees it as still pending.
export const getMyReferralStats = async (inviterId: AccountId) => {
  try {
    const [result] = await InviteRepository.aggregate([
      { $match: { inviterId: new mongoose.Types.ObjectId(inviterId) } },
      {
        $group: {
          _id: null,
          totalInvites: { $sum: 1 },
          acceptedCount: {
            $sum: { $cond: [{ $eq: ["$status", InviteStatus.ACCEPTED] }, 1, 0] },
          },
          totalEarnedCents: {
            $sum: {
              $cond: [
                { $gt: [{ $ifNull: ["$inviterRewardedAt", null] }, null] },
                { $ifNull: ["$rewardAmountCents", 0] },
                0,
              ],
            },
          },
          pendingRewardCount: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$status", InviteStatus.ACCEPTED] },
                    { $eq: [{ $ifNull: ["$inviterRewardedAt", null] }, null] },
                    // The zero-tier path terminates a claim as "paid" with 0
                    // cents and NO inviterRewardedAt — done, never pending.
                    { $ne: ["$rewardStatus", "paid"] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ])
    return {
      totalInvites: result?.totalInvites ?? 0,
      acceptedCount: result?.acceptedCount ?? 0,
      totalEarnedCents: result?.totalEarnedCents ?? 0,
      pendingRewardCount: result?.pendingRewardCount ?? 0,
    }
  } catch (error) {
    return new UnknownRepositoryError(error)
  }
}
