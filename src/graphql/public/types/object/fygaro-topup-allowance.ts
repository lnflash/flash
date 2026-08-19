import { GT } from "@graphql/index"
import CentAmount from "@graphql/public/types/scalar/cent-amount"
import Timestamp from "@graphql/shared/types/scalar/timestamp"

const FygaroTopupAllowance = GT.Object({
  name: "FygaroTopupAllowance",
  description:
    "How much of today's card top-up allowance this account has left. Does not " +
    "authorise anything, so it is safe to call while the customer is still choosing " +
    "an amount. Render all of them: `remaining` is the cap less BOTH `spent` and " +
    "`held`, so without those two the gap cannot be explained. Floored at zero, so it " +
    "can be LARGER than `limit - spent - held` when the cap has been exceeded — via a " +
    "hand-credit, or via spend recorded before a limit change. The largest amount " +
    "that would actually go through is `min(remaining, singlePaymentLimit)`, and " +
    "anything below `minimum` is refused.",
  fields: () => ({
    limit: {
      type: GT.NonNull(CentAmount),
      description: "The account level's rolling 24-hour cap.",
    },
    spent: {
      type: GT.NonNull(CentAmount),
      description:
        "Gross charged in the trailing 24 hours. Payments we captured but did not " +
        "credit are excluded — they delivered nothing, so they do not spend the allowance.",
    },
    held: {
      type: GT.NonNull(CentAmount),
      description:
        "Card top-up links this account has open but has not paid. NOT spent — nothing " +
        "has been charged — but not available either, because paying one would charge " +
        "it. The common case is a customer who minted a link and closed the page, so " +
        "this is usually the whole difference between `limit - spent` and `remaining`.",
    },
    remaining: {
      type: GT.NonNull(CentAmount),
      description:
        "What would still be accepted right now AGAINST THE DAILY CAP: the cap less " +
        "BOTH `spent` and `held`. Unpaid checkout links are already subtracted, exactly " +
        "as the pre-charge check subtracts them, so this is what a new top-up is " +
        "measured against — not `limit - spent`. Never negative. NOT the largest " +
        "payable amount on its own: `singlePaymentLimit` is a separate ceiling and is " +
        "deliberately not folded in here, or this number would stop meaning 'daily " +
        "headroom' and `resetsAt` would stop describing it.",
    },
    singlePaymentLimit: {
      type: GT.NonNull(CentAmount),
      description:
        "The most that can be charged in ONE top-up, whatever the daily headroom. A " +
        "separate gate from the cap, so an account with $500 remaining and a $200 " +
        "single-payment limit can only pay $200 at a time — offering the $500 gets the " +
        "charge refused. Take `min(remaining, singlePaymentLimit)` as the maximum.",
    },
    minimum: {
      type: GT.NonNull(CentAmount),
      description:
        "The smallest top-up that will be accepted. Enforced before the charge, so a " +
        "client that does not render it can only discover it by being refused.",
    },
    resetsAt: {
      type: Timestamp,
      description:
        "When the oldest counted PAYMENT ages out and the allowance it spent returns. " +
        "Covers settled spend only — a hold is not a payment and never moves this. " +
        "Null when no payment is counted, even if `held` is non-zero; see `holdsExpireAt`.",
    },
    holdsExpireAt: {
      type: Timestamp,
      description:
        "When the SOONEST unpaid checkout link expires and its hold on the allowance " +
        "lifts by itself. Null when `held` is zero. This is the answer to 'why is " +
        "$65 left when I have spent nothing, and when do I get the rest back?'.",
    },
  }),
})

/**
 * Why no allowance could be reported.
 *
 * The point of naming these is the difference between PERMANENT and TRANSIENT.
 * Two of them are permanent for this account right now — card top-ups are off,
 * or the level has no cap at all — and a client that cannot tell them apart
 * from an ERPNext blip renders the card top-up option anyway and has
 * `fygaroCheckoutCreate` refuse every single attempt. That is the
 * invite-then-refuse loop the allowance query exists to end, rebuilt on the
 * query added to end it.
 */
export const FygaroTopupAllowanceUnavailableReasonEnum = GT.Enum({
  name: "FygaroTopupAllowanceUnavailableReason",
  values: {
    CHECKOUT_DISABLED: {
      value: "checkout-disabled",
      description:
        "PERMANENT until an operator acts: card top-ups are switched off. Every " +
        "fygaroCheckoutCreate is refused in this state, so hide the card top-up " +
        "option rather than polling.",
    },
    LEVEL_NOT_ELIGIBLE: {
      value: "no-daily-limit-for-level",
      description:
        "PERMANENT until the account is upgraded: this account level has no card " +
        "top-up allowance at all. Hide the option and point at verification; retrying " +
        "changes nothing.",
    },
    SETTINGS_UNAVAILABLE: {
      value: "settings-unavailable",
      description:
        "TRANSIENT: the operator settings could not be read. Retry — nothing about " +
        "the account has changed.",
    },
    HISTORY_UNAVAILABLE: {
      value: "history-unavailable",
      description:
        "TRANSIENT: the trailing-24h top-up history could not be read. We refuse to " +
        "guess rather than show a full allowance we would then refuse to honour.",
    },
    RESERVATIONS_UNAVAILABLE: {
      value: "reservations-unavailable",
      description:
        "TRANSIENT: this account's open checkout links could not be read, so the " +
        "allowance cannot be known. Unknown holds are not zero holds.",
    },
    RATE_LIMITED: {
      value: "rate-limited",
      description:
        "TRANSIENT: too many allowance checks from this account too quickly. Back off " +
        "and reuse the last answer; nothing here is authorised, so no charge was lost.",
    },
  },
})

export const FygaroTopupAllowancePayload = GT.Object({
  name: "FygaroTopupAllowancePayload",
  description:
    "The allowance, or why there isn't one. Exactly one of the two fields is ever " +
    "set. `unavailableReason` exists so the client can tell a state that will never " +
    "resolve on its own (hide the card top-up option) from a momentary read failure " +
    "(show the flat limit, retry) — collapsing both into a missing allowance is what " +
    "invites a top-up the pre-charge check then refuses.",
  fields: () => ({
    allowance: {
      type: FygaroTopupAllowance,
      description: "Null whenever `unavailableReason` is set, and only then.",
    },
    unavailableReason: {
      type: FygaroTopupAllowanceUnavailableReasonEnum,
      description: "Null whenever `allowance` is present, and only then.",
    },
  }),
})

export default FygaroTopupAllowance
