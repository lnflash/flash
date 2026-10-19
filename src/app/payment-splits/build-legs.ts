import { PaymentSplitsConfig } from "@config"

import { computeShare, isSplitCurrency, type SplitLegKind } from "@domain/payment-splits"

import { isInternalTransferInvoice } from "@services/mongoose/internal-transfer-invoices"
import { PaymentSplitExecutionsRepository } from "@services/mongoose/payment-split-executions"
import { PaymentSplitRulesRepository } from "@services/mongoose/payment-split-rules"

export type BuildLegsResult = {
  recorded: number
  duplicates: number
}

const NOTHING: BuildLegsResult = { recorded: 0, duplicates: 0 }

/**
 * Builds the payout leg set for one receive settled on a shadow receive
 * account, under `triggerKey = paymentHash`. One `share` leg per enabled rule
 * (v1 computeShare, unchanged), plus one `net` leg to the merchant: gross
 * minus the sum of the shares, so rounding dust — and any share folded for
 * landing below minShareCents — stays with the merchant and the shadow
 * returns to exactly 0.
 *
 * All legs are inserted `pending` in one loop; the unique
 * (triggerKey, legKind, destinationWalletId) index makes a replay or a
 * reconcile re-run a duplicate-key no-op. Rules are snapshotted here: edits
 * after settle never touch legs already built.
 *
 * Never sends: payouts happen in the executor (webhook-adjacent in-process,
 * then the loop as the retry/safety net).
 *
 * `receivedAt`, when known (the reconcile reads it from IBEX, the webhook
 * from its body), keeps a rule from firing on a receive that settled before
 * the rule was created. Note this guards SHARE legs only — a receive on the
 * shadow only exists because a rule was enabled at invoice time, so the net
 * leg is always built.
 */
export const buildLegs = async ({
  walletId,
  sourceIbexAccountId,
  triggerKey,
  paymentHash,
  grossAmount,
  currency,
  receivedAt,
  now = new Date(),
}: {
  // The merchant's Flash wallet (the shadow's owner).
  walletId: string
  // The shadow IBEX account the receive settled on; every leg pays FROM it.
  sourceIbexAccountId: string
  triggerKey: string
  paymentHash?: string
  // The gross receive in major units as IBEX reports it (dollars / USDT).
  grossAmount: number
  currency: string
  receivedAt?: Date
  now?: Date
}): Promise<BuildLegsResult | Error> => {
  if (!PaymentSplitsConfig.enabled) return NOTHING
  if (!isSplitCurrency(currency)) return NOTHING

  // Invoices Flash minted for its own transfers (P2P, Fygaro top-ups, referral
  // payouts, split payouts, cutover moves) never trigger splits. A shadow
  // receive is always external by construction, but the marker check costs
  // one indexed read and keeps the invariant absolute: the marker is written
  // for the destination invoice of every payout leg, and a payout leg to a
  // wallet that itself has splits would otherwise settle on THAT wallet's
  // shadow if it ever landed there.
  if (paymentHash) {
    const internal = await isInternalTransferInvoice(paymentHash)
    if (internal instanceof Error) return internal
    if (internal) return NOTHING
  }

  // ENG-653 decision 1, kept: an LNURL send from another Flash user is marked
  // internal only after payToLnurl returns, so this receive can be built
  // before the marker exists. The executor re-checks the marker at pay time;
  // holding the rows back for claimGraceMs lets that marker land first.
  const firstClaimableAt = new Date(now.getTime() + PaymentSplitsConfig.claimGraceMs)

  const rules = await PaymentSplitRulesRepository().listByWalletId(walletId, {
    enabledOnly: true,
  })
  if (rules instanceof Error) return rules

  const executions = PaymentSplitExecutionsRepository()
  const result = { ...NOTHING }

  // The shares first, so the net can subtract the shares actually built.
  let sharesCents = 0
  type PlannedLeg = {
    legKind: SplitLegKind
    destinationWalletId: string
    ruleId: string
    shareCents: number
  }
  const planned: PlannedLeg[] = []

  for (const rule of rules) {
    if (receivedAt && receivedAt.getTime() < rule.createdAt.getTime()) continue

    const share = computeShare({
      amount: grossAmount,
      currency,
      percent: rule.percent,
      minShareCents: PaymentSplitsConfig.minShareCents,
    })
    if (share instanceof Error) return share

    // A share below minShareCents folds into the net leg (decision 2:
    // fold, never fail) — it is not recorded as its own row.
    if (share.status === "skipped_min") continue

    sharesCents += share.shareCents
    planned.push({
      legKind: "share",
      destinationWalletId: rule.destinationWalletId,
      ruleId: rule.id,
      shareCents: share.shareCents,
    })
  }

  // Gross in minor units, matching computeShare's conversion (the same round
  // of the same float), so net = gross − Σ shares is exact in minor units.
  const perMajor = currency === "USDT" ? 1_000_000n : 100n
  const grossMinor = BigInt(Math.round(grossAmount * Number(perMajor)))
  const netCents = Number(grossMinor / (perMajor / 100n)) - sharesCents
  if (netCents < 0) {
    // Rules summing over 100 are refused at save time; a rule edited between
    // snapshot and build cannot push Σ shares past the gross either (each
    // share is floored). Unreachable in practice; refuse rather than pay a
    // negative leg.
    return new Error(
      `split legs exceed the gross: net ${netCents} cents for trigger ${triggerKey}`,
    )
  }

  // The merchant is the net destination. The wallet record's id IS the
  // merchant's IBEX account id, so the leg pays wallet → wallet from the
  // shadow. ruleId is required by the schema; the net leg has no rule, so it
  // carries the merchant's wallet id as a stable placeholder.
  planned.push({
    legKind: "net",
    destinationWalletId: walletId,
    ruleId: walletId,
    shareCents: netCents,
  })

  for (const leg of planned) {
    const inserted = await executions.insert({
      triggerKey,
      legKind: leg.legKind,
      ruleId: leg.ruleId,
      walletId,
      sourceIbexAccountId,
      destinationWalletId: leg.destinationWalletId,
      currency,
      grossMinor: grossMinor.toString(),
      shareCents: leg.shareCents,
      status: "pending",
      nextAttemptAt: firstClaimableAt,
      now,
    })
    if (inserted instanceof Error) return inserted
    if (!inserted.inserted) result.duplicates += 1
    else result.recorded += 1
  }

  return result
}
