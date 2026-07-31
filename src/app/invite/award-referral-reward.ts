import { getReferralRewardConfig } from "@config"

import { InviteStatus } from "@domain/invite"
import { referralRewardAmountCents } from "@domain/invite/referral-reward"
import { PaymentSendStatus } from "@domain/bitcoin/lightning"
import { WalletCurrency } from "@domain/shared"

import { AccountsRepository, WalletsRepository } from "@services/mongoose"
import { InviteRepository } from "@services/mongoose/models/invite"
import { nextReferralRewardSeq } from "@services/mongoose/models/referral-reward-counter"
import { baseLogger } from "@services/logger"

const REWARDS_ROLE = "rewards"

type PartyPayResult = "paid" | "pending" | "failed"

const walletsFor = async (accountId: AccountId): Promise<Wallet[]> => {
  const wallets = await WalletsRepository().listByAccountId(accountId)
  return wallets instanceof Error ? [] : wallets
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
//  - No stranded claims: any unexpected throw after the claim downgrades it to
//    "failed" with a rewardError; `rewardClaimedAt` is stamped at claim time so
//    an ops sweep can find rows stuck in "processing" (e.g. pod killed
//    mid-payout before any terminal mark landed).
//  - Never throws into the KYC path: all errors are caught and logged.
export const awardReferralRewardOnKycApproval = async ({
  accountId,
}: {
  accountId: AccountId
}): Promise<void> => {
  try {
    const config = getReferralRewardConfig()
    if (!config.enabled) return

    // One reward per invitee, ever. Bridge KYC can flap back to "approved"
    // (approved -> under_review -> approved re-fires this hook), and redemption
    // history may hold more than one accepted invite — if ANY invite for this
    // account was already claimed for a reward, never pay a second one.
    const alreadyProcessed = await InviteRepository.exists({
      redeemedById: accountId,
      rewardStatus: { $exists: true },
    })
    if (alreadyProcessed) return

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
      { $set: { rewardStatus: "processing", rewardClaimedAt: new Date() } },
      { new: true },
    )
    if (!invite) return // lost the race to a concurrent caller

    // The claim is ours from here: an unexpected throw must not strand an
    // invisible "processing" row, so the remainder runs under its own catch
    // that downgrades the claim to "failed" for reconciliation. Party results
    // are hoisted so the catch can preserve evidence of any payment that
    // already went out before the throw (a re-pay must never look safe).
    let seq: number | undefined
    let inviterResult: PartyPayResult = "failed"
    let inviteeResult: PartyPayResult = "failed"
    try {
      // Reserve the global sequence number and resolve this referral's amount.
      seq = await nextReferralRewardSeq()
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
      const inviteeAccountId = (invite.redeemedById?.toString() ?? accountId) as AccountId

      // Resolve the funding wallet: prefer the USDT wallet (the active cash
      // wallet on every account — see accounts/create-account.ts), falling
      // back to the legacy USD wallet.
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
      const rewardsWallets = await walletsFor(rewardsAccount.id)
      const rewardsWallet =
        rewardsWallets.find((w) => w.currency === WalletCurrency.Usdt) ??
        rewardsWallets.find((w) => w.currency === WalletCurrency.Usd)
      if (!rewardsWallet) {
        await markReward(invite._id, {
          rewardStatus: "failed",
          rewardSeq: seq,
          rewardAmountCents: amountCents,
          rewardError: "rewards account has no USDT or USD wallet",
        })
        baseLogger.error(
          { accountId, seq },
          "referral reward: rewards account has no USDT or USD wallet",
        )
        return
      }

      // Recipients must hold a wallet in the funding wallet's currency —
      // send-intraledger rejects cross-currency sends.
      const payoutCurrency = rewardsWallet.currency
      const walletIdWithPayoutCurrency = async (recipientAccountId: AccountId) =>
        (await walletsFor(recipientAccountId)).find((w) => w.currency === payoutCurrency)
          ?.id

      const inviterWalletId = await walletIdWithPayoutCurrency(inviterAccountId)
      const inviteeWalletId = await walletIdWithPayoutCurrency(inviteeAccountId)
      const memo = `Flash referral reward (#${seq})`

      const payParty = async (
        recipientWalletId: WalletId | undefined,
      ): Promise<PartyPayResult> => {
        if (!recipientWalletId) return "failed"
        // Lazy-import so merely importing @app/invite doesn't pull the IBEX
        // client (and its module-load side effects) into unrelated code paths.
        const { intraledgerPaymentSendWalletIdForUsdWallet } = await import(
          "@app/payments/send-intraledger"
        )
        const result = await intraledgerPaymentSendWalletIdForUsdWallet({
          senderWalletId: rewardsWallet.id,
          recipientWalletId,
          amount: amountCents,
          memo,
        })
        if (result instanceof Error) {
          baseLogger.error(
            { err: result, recipientWalletId, seq },
            "referral reward: payout returned an error",
          )
          return "failed"
        }
        if (result === PaymentSendStatus.Success) return "paid"
        // An IBEX-pending send has probably left the funding wallet: mark the
        // party rewarded (never risk a double-pay on a re-run) but keep the
        // invite in a non-terminal "pending" status so ops re-checks it.
        if (result === PaymentSendStatus.Pending) return "pending"
        return "failed"
      }

      // Pay each party independently so a single failure can't undo the other.
      inviterResult = await payParty(inviterWalletId)
      inviteeResult = await payParty(inviteeWalletId)

      const now = new Date()
      const rewardStatus =
        inviterResult === "paid" && inviteeResult === "paid"
          ? "paid"
          : inviterResult === "failed" && inviteeResult === "failed"
            ? "failed"
            : inviterResult === "failed" || inviteeResult === "failed"
              ? "partial"
              : "pending"

      const update: Record<string, unknown> = {
        rewardStatus,
        rewardSeq: seq,
        rewardAmountCents: amountCents,
      }
      // Timestamps are set for pending parties too: the money has probably
      // moved, and a missing timestamp must never invite a second payment.
      if (inviterResult !== "failed") update.inviterRewardedAt = now
      if (inviteeResult !== "failed") update.inviteeRewardedAt = now
      if (rewardStatus === "paid") update.rewardedAt = now
      else {
        update.rewardError =
          `inviter=${inviterResult} invitee=${inviteeResult} ` +
          `currency=${payoutCurrency} inviterWallet=${Boolean(inviterWalletId)} ` +
          `inviteeWallet=${Boolean(inviteeWalletId)}`
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
      // Downgrade the claim so the row is visible to reconciliation instead of
      // stranded in "processing" forever — preserving evidence of any party
      // already paid before the throw so reconciliation can't double-pay them.
      baseLogger.error(
        { err, accountId, seq, inviterResult, inviteeResult },
        "referral reward: unexpected error after claim",
      )
      const anyPartyPaid = inviterResult !== "failed" || inviteeResult !== "failed"
      const update: Record<string, unknown> = {
        rewardStatus: anyPartyPaid ? "partial" : "failed",
        rewardError:
          `unexpected: ${String(err)} ` +
          `(inviter=${inviterResult} invitee=${inviteeResult})`,
        ...(seq !== undefined ? { rewardSeq: seq } : {}),
      }
      const now = new Date()
      if (inviterResult !== "failed") update.inviterRewardedAt = now
      if (inviteeResult !== "failed") update.inviteeRewardedAt = now
      await markReward(invite._id, update)
    }
  } catch (err) {
    // A reward failure must never break KYC approval.
    baseLogger.error({ err, accountId }, "referral reward: unexpected error")
  }
}
