import { getFygaroTopupStatus } from "@app/fygaro/topup-status"
import { GT } from "@graphql/index"
import FygaroTopupStatus from "@graphql/public/types/object/fygaro-topup-status"

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`

/**
 * Turn an internal gate reason into something worth showing a customer who has
 * already been charged.
 *
 * Two classes, and conflating them is how support tickets get created. A
 * threshold the customer tripped is theirs to act on and gets named with its
 * number. Anything that is OUR fault — a disabled toggle, an unreadable
 * settings row, a failed credit — is never dressed up as the customer's
 * problem; they get told we are completing it, and an operator gets paged
 * (already handled at the webhook).
 */
const customerReason = (
  reason: string | undefined,
  detailCents: number | undefined,
): string | undefined => {
  switch (reason) {
    case "daily-limit-exceeded":
      return detailCents === undefined
        ? "This is more than your remaining daily top-up limit."
        : `This is more than your remaining daily top-up limit of ${dollars(detailCents)}.`
    case "over-limit":
      return detailCents === undefined
        ? "Top-ups above our automatic limit need a quick manual review."
        : `Top-ups over ${dollars(detailCents)} need a quick manual review.`
    case "under-minimum":
      return detailCents === undefined
        ? "This is below the minimum top-up."
        : `The minimum top-up is ${dollars(detailCents)}.`
    case "no-daily-limit-for-level":
      return "Card top-ups aren't available on your account level yet."
    case "intent-mismatch":
      return "We couldn't match this payment to your checkout, so we're completing it by hand."
    case undefined:
      return undefined
    default:
      // credit-disabled, auto-credit-disabled, settings-unavailable,
      // history-unavailable, non-positive-net, non-usd, credit-failed — all
      // ours. Say what we are doing about it, not what they did wrong.
      return "We've received your payment and are completing it manually."
  }
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
