/**
 * Operator reconciliation for referral rewards deferred by the ERPNext kill
 * switch (see referral-settings.ts and award-referral-reward.ts). While the
 * switch is off (or unreadable), a matching Bridge KYC approval leaves its
 * invite ACCEPTED and unrewarded rather than paying or marking it failed —
 * a deferred payout, not a lost one. This sweep finds that backlog and,
 * unless dryRun, replays the award hook for every distinct account in it.
 *
 * Also usable in dry-run alone: an operator about to flip the switch back on
 * can see the backlog size up front instead of relying on grepping logs for
 * "deferred" lines.
 */
import { InviteStatus } from "@domain/invite"

import { InviteRepository } from "@services/mongoose/models/invite"
import { baseLogger } from "@services/logger"

import { awardReferralRewardOnKycApproval } from "./award-referral-reward"

export type RetryDeferredReferralRewardsResult = {
  backlogCount: number
  accountsRetried: number
}

/**
 * awardReferralRewardOnKycApproval is itself idempotent and fail-closed — it
 * re-checks the ERPNext switch, the already-processed guard, and the atomic
 * reward claim — so re-invoking it here is always safe: a still-disabled
 * switch or an already-claimed invite is a silent no-op, never a double-pay.
 */
export const retryDeferredReferralRewards = async ({
  dryRun,
}: {
  dryRun: boolean
}): Promise<RetryDeferredReferralRewardsResult> => {
  const deferred = await InviteRepository.find({
    status: InviteStatus.ACCEPTED,
    rewardStatus: { $exists: false },
    redeemedById: { $exists: true },
  })

  // Redemption history can hold more than one accepted invite for the same
  // account, but the award hook only ever pays one — dedupe before retrying
  // so the same account isn't looked up twice for nothing.
  const accountIds = [
    ...new Set(
      deferred
        .map((invite) => invite.redeemedById?.toString())
        .filter((id): id is string => Boolean(id)),
    ),
  ] as AccountId[]

  baseLogger.info(
    { backlogCount: deferred.length, accounts: accountIds.length, dryRun },
    "referral reward backlog: accepted + unrewarded invites found",
  )

  if (dryRun) return { backlogCount: deferred.length, accountsRetried: 0 }

  for (const accountId of accountIds) {
    await awardReferralRewardOnKycApproval({ accountId })
  }

  return { backlogCount: deferred.length, accountsRetried: accountIds.length }
}
