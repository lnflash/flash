import { InviteRepository } from "@services/mongoose/models/invite"
import { AccountsRepository } from "@services/mongoose"
import { InviteStatus, InviteId } from "@domain/invite"
import { UnknownRepositoryError, CouldNotFindError } from "@domain/errors"
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
    }
  } catch (error) {
    return new UnknownRepositoryError(error)
  }
}

export const listInvites = async ({
  first = 20,
  skip = 0,
  status,
  inviterId,
}: {
  first?: number
  skip?: number
  status?: InviteStatus
  inviterId?: AccountId
}) => {
  try {
    const matchQuery: Record<string, unknown> = {}

    if (status) {
      matchQuery.status = status
    }

    if (inviterId) {
      matchQuery.inviterId = inviterId
    }

    const [result] = await InviteRepository.aggregate([
      { $match: matchQuery },
      {
        $facet: {
          data: [
            { $sort: { createdAt: -1 } },
            { $skip: skip },
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
