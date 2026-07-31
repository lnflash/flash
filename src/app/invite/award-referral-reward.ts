import { getReferralRewardConfig } from "@config"

import { InviteStatus } from "@domain/invite"
import { referralRewardAmountCents } from "@domain/invite/referral-reward"
import { PaymentSendStatus } from "@domain/bitcoin/lightning"
import { WalletCurrency } from "@domain/shared"

import { intraledgerPaymentSendWalletIdForUsdWallet } from "@app/payments/send-intraledger"

import { AccountsRepository, WalletsRepository } from "@services/mongoose"
import { InviteRepository } from "@services/mongoose/models/invite"
import { nextReferralRewardSeq } from "@services/mongoose/models/referral-reward-counter"
import { baseLogger } from "@services/logger"

const REWARDS_ROLE = "rewards"

const findUsdWalletId = async (
  accountId: AccountId,
): Promise<WalletId | undefined> => {
  const wallets = await WalletsRepository().listByAccountId(accountId)
  if (wallets instanceof Error) return undefined
  return wallets.find((w) => w.currency === WalletCurrency.Usd)?.id
}

const markReward = async (
  inviteId: unknown,
  update: Record<string, unknown>,
): Promise<void> => {
  await InviteRepository.updateOne({ _id: inviteId }, { $set: update })
}

// Fired when an invited user's Bridge KYC is approved (they now have a US
// account). Pays a tiered referral reward, in USD cents, to BOTH the inviter
// and the invitee, funded from the account holding the "rewards" role.
//
// Guarantees:
//  - Idempotent & fail-closed: an atomic claim on the invite (absent ->
//    "processing") ensures a referral is processed once; a party is never
//    paid twice. A failed/partial payout is recorded (not retried) for manual
//    reconciliation rather than risking a double-pay.
//  - Never throws into the KYC path: all errors are caught and logged.
export const awardReferralRewardOnKycApproval = async ({
  accountId,
}: {
  accountId: AccountId
}): Promise<void> => {
  try {
    const config = getReferralRewardConfig()
    if (!config.enabled) return

    // Only accepted invites that have not yet been claimed for a reward.
    const pending = await InviteRepository.findOne({
      redeemedById: accountId,
      status: InviteStatus.ACCEPTED,
      rewardStatus: { $exists: false },
    })
    if (!pending) return // not a referred user, or already claimed

    // Atomic claim — only one caller flips absent -> "processing".
    const invite = await InviteRepository.findOneAndUpdate(
      { _id: pending._id, rewardStatus: { $exists: false } },
      { $set: { rewardStatus: "processing" } },
      { new: true },
    )
    if (!invite) return // lost the race to a concurrent caller

    // Reserve the global sequence number and resolve this referral's amount.
    const seq = await nextReferralRewardSeq()
    const amountCents = referralRewardAmountCents(config.tiers, seq)

    if (amountCents <= 0) {
      await markReward(invite._id, {
        rewardStatus: "paid",
        rewardSeq: seq,
        rewardAmountCents: 0,
        rewardedAt: new Date(),
      })
      return
    }

    const inviterAccountId = invite.inviterId.toString() as AccountId
    const inviteeAccountId = (invite.redeemedById?.toString() ??
      accountId) as AccountId

    // Resolve the funding wallet.
    const rewardsAccount = await AccountsRepository().findByRole(REWARDS_ROLE)
    if (rewardsAccount instanceof Error) {
      await markReward(invite._id, {
        rewardStatus: "failed",
        rewardSeq: seq,
        rewardAmountCents: amountCents,
        rewardError: "rewards account not configured",
      })
      baseLogger.error(
        { accountId, seq },
        "referral reward: no account holds the 'rewards' role",
      )
      return
    }
    const rewardsWalletId = await findUsdWalletId(rewardsAccount.id)
    if (!rewardsWalletId) {
      await markReward(invite._id, {
        rewardStatus: "failed",
        rewardSeq: seq,
        rewardAmountCents: amountCents,
        rewardError: "rewards account has no USD wallet",
      })
      baseLogger.error(
        { accountId, seq },
        "referral reward: rewards account has no USD wallet",
      )
      return
    }

    const inviterWalletId = await findUsdWalletId(inviterAccountId)
    const inviteeWalletId = await findUsdWalletId(inviteeAccountId)
    const memo = `Flash referral reward (#${seq})`

    const payParty = async (
      recipientWalletId: WalletId | undefined,
    ): Promise<boolean> => {
      if (!recipientWalletId) return false
      const result = await intraledgerPaymentSendWalletIdForUsdWallet({
        senderWalletId: rewardsWalletId,
        recipientWalletId,
        amount: amountCents,
        memo,
      })
      if (result instanceof Error) {
        baseLogger.error(
          { err: result, recipientWalletId, seq },
          "referral reward: payout returned an error",
        )
        return false
      }
      return (
        result === PaymentSendStatus.Success || result === PaymentSendStatus.Pending
      )
    }

    // Pay each party independently so a single failure can't undo the other.
    const inviterPaid = await payParty(inviterWalletId)
    const inviteePaid = await payParty(inviteeWalletId)

    const now = new Date()
    const rewardStatus =
      inviterPaid && inviteePaid
        ? "paid"
        : inviterPaid || inviteePaid
          ? "partial"
          : "failed"

    const update: Record<string, unknown> = {
      rewardStatus,
      rewardSeq: seq,
      rewardAmountCents: amountCents,
    }
    if (inviterPaid) update.inviterRewardedAt = now
    if (inviteePaid) update.inviteeRewardedAt = now
    if (rewardStatus === "paid") update.rewardedAt = now
    else {
      update.rewardError =
        `inviterPaid=${inviterPaid} inviteePaid=${inviteePaid} ` +
        `inviterWallet=${Boolean(inviterWalletId)} inviteeWallet=${Boolean(
          inviteeWalletId,
        )}`
    }
    await markReward(invite._id, update)

    if (rewardStatus === "paid") {
      baseLogger.info(
        { accountId, seq, amountCents },
        "referral reward paid to both parties",
      )
    } else {
      baseLogger.error(
        { accountId, seq, rewardStatus, update },
        "referral reward not fully paid — needs manual reconciliation",
      )
    }
  } catch (err) {
    // A reward failure must never break KYC approval.
    baseLogger.error({ err, accountId }, "referral reward: unexpected error")
  }
}
