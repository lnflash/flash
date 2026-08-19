import type { FygaroTopupState } from "@app/fygaro/topup-status"
import { GT } from "@graphql/index"
import CentAmount from "@graphql/public/types/scalar/cent-amount"

/**
 * The INTERNAL value behind each enum member — what a resolver must actually
 * return for GraphQL to serialize the member's name onto the wire.
 *
 * Typed as `FygaroTopupState`, the app-layer union, for the same reason the
 * sibling enum's values are typed (`FygaroTopupAllowanceUnavailableReasonValue`
 * in `fygaro-topup-allowance.ts`): as bare string literals these five wire
 * strings lived in two places — these `value:` entries and the union the app
 * layer returns — with nothing linking them. Renaming one `value:`, or adding a
 * state to `FygaroTopupOutcomeState`/`FygaroTopupState` and forgetting a member
 * here, compiled and passed every test, then threw
 * `Enum "FygaroTopupState" cannot represent value: ...` at every customer
 * polling the status of the exact payment this query exists to explain.
 *
 * As the declared type of the `value:` side, a rename on either is now a
 * compile error. `fygaro-topup-status.spec.ts` also serializes every state the
 * resolver can return through the real enum, so a value no member carries fails
 * at runtime too.
 */
const STATE_ENUM_VALUES: Record<
  string,
  { value: FygaroTopupState; description: string }
> = {
  UNCONFIRMED: {
    value: "unconfirmed",
    description:
      "No payment has been observed for this checkout. The customer may still be on " +
      "the payment page, the card may have been declined, the page may have been " +
      "cancelled — or we may be momentarily unable to check. NEVER render this as " +
      "'payment received': the payment page closes on a decline exactly as it does " +
      "on a success. Keep polling, then fall back to 'we'll let you know'.",
  },
  PROCESSING: {
    value: "processing",
    description:
      "We have the payment — the provider told us so — and are crediting it. Not " +
      "yet terminal, so keep polling, then fall back to telling the customer they " +
      "will be notified.",
  },
  CREDITED: { value: "credited", description: "Money is in the wallet." },
  HELD_FOR_REVIEW: {
    value: "held-for-review",
    description:
      "Captured and deliberately not credited. Terminal until a human acts, so " +
      "retrying achieves nothing — show the reason.",
  },
  FAILED: {
    value: "failed",
    description:
      "We tried to credit and it failed. A provider retry may still resolve it, so " +
      "this is 'we are on it', not 'contact support'.",
  },
}

export const FygaroTopupStateEnum = GT.Enum({
  name: "FygaroTopupState",
  values: STATE_ENUM_VALUES,
})

const FygaroTopupStatus = GT.Object({
  name: "FygaroTopupStatus",
  description:
    "What actually happened to a card top-up. The card charge succeeding and Flash " +
    "crediting the wallet are different events; only this reports the second.",
  fields: () => ({
    state: { type: GT.NonNull(FygaroTopupStateEnum) },
    authorizedAmount: {
      type: CentAmount,
      description:
        "The amount this checkout was authorised for. Null ONLY when the checkout " +
        "record could not be read (state UNCONFIRMED, transient): the amount lives on " +
        "that record. The client already knows what it asked for, so this is an echo, " +
        "never the source of truth for what was charged.",
    },
    netAmount: {
      type: CentAmount,
      description: "What reached the wallet, after fees. Present once credited.",
    },
    reason: {
      type: GT.String,
      description:
        "Customer-facing explanation, present when the state needs one. Reasons the " +
        "customer can act on are named plainly; our own faults are not blamed on them.",
    },
  }),
})

export default FygaroTopupStatus
