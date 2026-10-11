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
 *
 * `account` / `inviter` narrow the sweep (inside the Mongo query) to one
 * invitee or one inviter: the Referral Payout Allowlist flow, where an
 * operator replays a just-allowlisted account's deferred reward. The result
 * then reports whether that account is currently allowlisted, so a dry run
 * shows "not allowlisted" instead of a silent no-op.
 */
import { InviteStatus } from "@domain/invite"

import { InviteRepository } from "@services/mongoose/models/invite"
import { baseLogger } from "@services/logger"

import { awardReferralRewardOnKycApproval } from "./award-referral-reward"
import { accountAllowlistedForReferralPayout } from "./referral-payout-allowlist"

export type RetryDeferredReferralRewardsResult = {
  backlogCount: number
  accountsRetried: number
  // Set only when the sweep is filtered to that party.
  allowlisted?: boolean
  inviterAllowlisted?: boolean
}

/**
 * awardReferralRewardOnKycApproval is itself idempotent and fail-closed — it
 * re-checks the ERPNext switch, the already-processed guard, and the atomic
 * reward claim — so re-invoking it here is always safe: a still-disabled
 * switch or an already-claimed invite is a silent no-op, never a double-pay.
 */
export const retryDeferredReferralRewards = async ({
  dryRun,
  account,
  inviter,
}: {
  dryRun: boolean
  account?: AccountId
  inviter?: AccountId
}): Promise<RetryDeferredReferralRewardsResult> => {
  const deferred = await InviteRepository.find({
    status: InviteStatus.ACCEPTED,
    rewardStatus: { $exists: false },
    redeemedById: account ?? { $exists: true },
    ...(inviter ? { inviterId: inviter } : {}),
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

  const allowlistReport: Pick<
    RetryDeferredReferralRewardsResult,
    "allowlisted" | "inviterAllowlisted"
  > = {}
  if (account)
    allowlistReport.allowlisted = await accountAllowlistedForReferralPayout(account)
  if (inviter)
    allowlistReport.inviterAllowlisted =
      await accountAllowlistedForReferralPayout(inviter)
  const filterReport = {
    ...(account ? { account } : {}),
    ...(inviter ? { inviter } : {}),
    ...allowlistReport,
  }

  baseLogger.info(
    {
      backlogCount: deferred.length,
      accounts: accountIds.length,
      dryRun,
      ...filterReport,
    },
    "referral reward backlog: accepted + unrewarded invites found",
  )

  if (deferred.length === 0 && (account || inviter)) {
    baseLogger.warn(
      { account, inviter },
      "referral reward backlog: no accepted + unrewarded invite for the requested account/inviter",
    )
  }

  if (dryRun)
    return { backlogCount: deferred.length, accountsRetried: 0, ...allowlistReport }

  for (const accountId of accountIds) {
    await awardReferralRewardOnKycApproval({ accountId })
  }

  return {
    backlogCount: deferred.length,
    accountsRetried: accountIds.length,
    ...allowlistReport,
  }
}
