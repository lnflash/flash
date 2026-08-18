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
  // NOTHING is known about a payment for this checkout. The record is written
  // when the link is MINTED, so this covers the customer still on the payment
  // page, the declined card, the closed tab — and the Redis fault that stopped
  // us reading at all. Deliberately NOT "processing": the client polls after
  // the payment page closes, and that page closes on a decline and a cancel
  // just as it does on a success, so any wording that asserts receipt here is
  // a claim about money that may never have moved.
  | "unconfirmed"
  // The webhook has recorded the payment and no terminal answer has been
  // reached yet. This one IS "we have your payment, we're crediting it",
  // because the server has actually seen it.
  | "processing"
  | "credited"
  // Captured and deliberately not credited. Terminal until a human acts.
  | "held-for-review"
  // Credit attempted and failed. A provider retry may still resolve it.
  | "failed"

export type FygaroTopupStatus = {
  state: FygaroTopupState
  // Undefined only when the record could not be read at all (`unavailable`
  // below): the amount lives on that record, so there is nothing to report.
  authorizedAmountCents?: number
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
  //
  // `unavailable` splits out the one case that is NOT an answer about the
  // checkout: the store could not be read. `readIntent` is fail-open by design
  // (every cache error, not just a miss, comes back as `found: false`), so
  // without this a Redis blip tells a customer who has just been charged that
  // their checkout does not exist. The caller degrades to `unconfirmed`
  // instead — "we cannot confirm this yet", which is true — rather than to a
  // null that reads as "never happened".
  | { found: false; unavailable?: boolean }

// A record with no outcome, and a record we could not read, answer the same
// way: nothing about this payment is confirmed. Neither says "received".
const UNCONFIRMED: FygaroTopupState = "unconfirmed"

export const getFygaroTopupStatus = async ({
  intentId,
  accountId,
}: {
  intentId: string
  accountId: string
}): Promise<FygaroTopupStatusResult> => {
  const lookup = await readIntent(intentId)
  if (!lookup.found) {
    return lookup.unavailable ? { found: false, unavailable: true } : { found: false }
  }

  // The intent id is a random uuid, so guessing one is impractical — but the
  // record names the account it was minted for, and checking costs nothing.
  // Payment state is exactly the kind of thing that must not leak across
  // accounts on a mere id match.
  if (lookup.intent.accountId !== accountId) return { found: false }

  const outcome = lookup.intent.outcome
  return {
    found: true,
    status: {
      // `received` is the webhook saying a payment arrived; that — and only
      // that — is what the client renders as "processing". No outcome at all
      // means no payment has been observed.
      state:
        outcome === undefined
          ? UNCONFIRMED
          : outcome.state === "received"
            ? "processing"
            : outcome.state,
      authorizedAmountCents: lookup.intent.amountCents,
      netAmountCents: outcome?.netAmountCents,
      reason: outcome?.reason,
      detailCents: outcome?.detailCents,
    },
  }
}
