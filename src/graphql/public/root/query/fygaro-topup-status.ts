import { getFygaroTopupStatus } from "@app/fygaro/topup-status"
import { GT } from "@graphql/index"
import FygaroTopupStatus from "@graphql/public/types/object/fygaro-topup-status"
import type { RecordOnlyReason } from "@services/fygaro/webhook-server/fees"

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`

// Everything that is OUR fault — a disabled toggle, an unreadable settings row,
// a failed credit. Say what we are doing about it, not what they did wrong.
const OURS = "We've received your payment and are completing it manually."

/**
 * Customer-facing wording for every reason the webhook can stamp.
 *
 * An exhaustive `Record`, not a switch with a `default`, and that is the whole
 * point: a `default` silently absorbs any reason added later, so a new
 * threshold gate would ship telling the customer "we're completing it manually"
 * for a limit they actually tripped, and nothing would fail. As a Record over
 * `RecordOnlyReason`, a new member of that union is a compile error here until
 * someone decides what the customer should be told. `authorize-topup.ts` pins
 * its own vocabulary the same way (`FAILURE_BY_GATE_REASON`).
 *
 * Two classes, and conflating them is how support tickets get created. A
 * threshold the customer tripped is theirs to act on and gets named with its
 * number. Ours is never dressed up as their problem — they get told we are
 * completing it, and an operator gets paged (already handled at the webhook).
 */
const CUSTOMER_REASON: Record<
  // `credit-failed` and `unattributed` are not gate reasons — the credit path
  // and the unattributed terminal stamp them directly — so they are added to
  // the union rather than being caught by a fallthrough.
  RecordOnlyReason | "credit-failed" | "unattributed",
  (detailCents?: number) => string
> = {
  "daily-limit-exceeded": (cents) =>
    cents === undefined
      ? "This is more than your remaining daily top-up limit."
      : `This is more than your remaining daily top-up limit of ${dollars(cents)}.`,
  "over-limit": (cents) =>
    cents === undefined
      ? "Top-ups above our automatic limit need a quick manual review."
      : `Top-ups over ${dollars(cents)} need a quick manual review.`,
  "under-minimum": (cents) =>
    cents === undefined
      ? "This is below the minimum top-up."
      : `The minimum top-up is ${dollars(cents)}.`,
  "no-daily-limit-for-level": () =>
    "Card top-ups aren't available on your account level yet.",
  "intent-mismatch": () =>
    "We couldn't match this payment to your checkout, so we're completing it by hand.",
  "credit-disabled": () => OURS,
  "auto-credit-disabled": () => OURS,
  "settings-unavailable": () => OURS,
  "history-unavailable": () => OURS,
  "non-positive-net": () => OURS,
  "non-usd": () => OURS,
  "credit-failed": () => OURS,
  // The signed reference named a username that no longer resolves to an
  // account. That is a mismatch on our side of the checkout, not a rule the
  // customer broke, so it gets the same wording as any other fault of ours.
  "unattributed": () => OURS,
}

const customerReason = (
  reason: string | undefined,
  detailCents: number | undefined,
): string | undefined => {
  if (reason === undefined) return undefined
  const wording = CUSTOMER_REASON[reason as keyof typeof CUSTOMER_REASON]
  // The map is exhaustive at compile time, but the reason arrives as a string
  // off a Redis record that an OLDER deployment may have written. An unknown
  // one is ours by definition — we cannot explain a rule we no longer have.
  return wording === undefined ? OURS : wording(detailCents)
}

const FygaroTopupStatusQuery = GT.Field({
  type: FygaroTopupStatus,
  description:
    "The outcome of a card top-up, by the checkout id returned from fygaroCheckoutCreate. " +
    "Null when the checkout is unknown, expired, or not this account's.",
  args: {
    checkoutId: { type: GT.NonNull(GT.String) },
  },
  resolve: async (_, args, { domainAccount }: GraphQLPublicContextAuth) => {
    const result = await getFygaroTopupStatus({
      intentId: args.checkoutId,
      accountId: domainAccount.id,
    })
    if (!result.found) return null

    const { state, authorizedAmountCents, netAmountCents, reason } = result.status
    return {
      state,
      authorizedAmount: authorizedAmountCents,
      netAmount: netAmountCents,
      reason: customerReason(reason, result.status.detailCents),
    }
  },
})

export default FygaroTopupStatusQuery
