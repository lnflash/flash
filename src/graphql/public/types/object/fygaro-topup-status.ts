import { GT } from "@graphql/index"
import CentAmount from "@graphql/public/types/scalar/cent-amount"

export const FygaroTopupStateEnum = GT.Enum({
  name: "FygaroTopupState",
  values: {
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
  },
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
