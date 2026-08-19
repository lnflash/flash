import {
  readIntent,
  type FygaroTopupOutcome,
  type FygaroTopupOutcomeState,
} from "@services/fygaro/checkout-intent-store"

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

/**
 * Stored outcome state -> the state the client is told.
 *
 * `received` is the webhook saying a payment arrived; that — and only that — is
 * what becomes "processing". The rest carry through unchanged, but they carry
 * through a MAP rather than a passthrough on purpose: `outcome.state` is a
 * string off a Redis record that another deployment wrote, and the value goes
 * straight to a GraphQL enum. A state a newer build stamps and this one has no
 * member for would be handed to the serializer and throw
 * `Enum "FygaroTopupState" cannot represent value: ...` — a hard error on the
 * status screen of a customer who has just been charged, for a record we can
 * read perfectly well.
 */
const STATE_BY_OUTCOME: Record<FygaroTopupOutcomeState, FygaroTopupState> = {
  "received": "processing",
  "credited": "credited",
  "held-for-review": "held-for-review",
  "failed": "failed",
}

// Same posture the reason mapping takes at the GraphQL edge: a value we do not
// recognise is not a value we may assert anything about. `unconfirmed` is the
// one answer that claims nothing — "we cannot confirm this yet, keep polling" —
// so an unknown state degrades to it rather than to a wrong claim or a throw.
const stateFor = (outcome: FygaroTopupOutcome | undefined): FygaroTopupState =>
  outcome === undefined ? UNCONFIRMED : (STATE_BY_OUTCOME[outcome.state] ?? UNCONFIRMED)

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
      // No outcome at all means no payment has been observed; everything else
      // goes through the map above, which is also the guard against a state
      // this build has no enum member for.
      state: stateFor(outcome),
      authorizedAmountCents: lookup.intent.amountCents,
      netAmountCents: outcome?.netAmountCents,
      reason: outcome?.reason,
      detailCents: outcome?.detailCents,
    },
  }
}
