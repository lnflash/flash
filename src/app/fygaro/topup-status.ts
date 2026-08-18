import { readIntent } from "@services/fygaro/checkout-intent-store"

/**
 * What happened to the payment made against one checkout authorisation.
 *
 * Exists because the app currently asserts something it cannot know. On any
 * Fygaro success redirect it navigates to "Payment Successful — Deposited to
 * <wallet>" with a fabricated transaction id, having asked no one. On
 * 2026-08-16 one customer saw that screen three times; twice nothing had been
 * deposited. The card charge succeeding and Flash crediting the wallet are two
 * different events, and only the second is what the customer came for.
 *
 * Served from the intent record in Redis rather than the ERPNext audit row.
 * ERPNext is already a hard dependency of AUTHORISING — its outage refuses
 * top-ups outright — and putting it on the status path too would mean a
 * customer who has just been charged cannot be told what happened. The intent
 * outlives the poll window by an hour; ERPNext remains the durable record.
 */

export type FygaroTopupState =
  // No terminal outcome recorded yet. The webhook may not have been delivered,
  // may be mid-flight, or may be in a deliberate retry loop. Honest answer:
  // "we have your payment, we're crediting it".
  | "processing"
  | "credited"
  // Captured and deliberately not credited. Terminal until a human acts.
  | "held-for-review"
  // Credit attempted and failed. A provider retry may still resolve it.
  | "failed"

export type FygaroTopupStatus = {
  state: FygaroTopupState
  authorizedAmountCents: number
  netAmountCents?: number
  // The raw gate reason, mapped to customer wording at the GraphQL edge.
  reason?: string
  // The threshold the payment fell foul of, when the reason has one.
  detailCents?: number
}

export type FygaroTopupStatusResult =
  | { found: true; status: FygaroTopupStatus }
  // Unknown, expired, or belonging to a different account. Collapsed into one
  // answer on purpose: distinguishing them would let a caller probe whether an
  // arbitrary intent id exists.
  | { found: false }

export const getFygaroTopupStatus = async ({
  intentId,
  accountId,
}: {
  intentId: string
  accountId: string
}): Promise<FygaroTopupStatusResult> => {
  const lookup = await readIntent(intentId)
  if (!lookup.found) return { found: false }

  // The intent id is a random uuid, so guessing one is impractical — but the
  // record names the account it was minted for, and checking costs nothing.
  // Payment state is exactly the kind of thing that must not leak across
  // accounts on a mere id match.
  if (lookup.intent.accountId !== accountId) return { found: false }

  const outcome = lookup.intent.outcome
  return {
    found: true,
    status: {
      state: outcome?.state ?? "processing",
      authorizedAmountCents: lookup.intent.amountCents,
      netAmountCents: outcome?.netAmountCents,
      reason: outcome?.reason,
      detailCents: outcome?.detailCents,
    },
  }
}
