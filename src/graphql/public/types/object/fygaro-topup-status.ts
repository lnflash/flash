import { GT } from "@graphql/index"
import CentAmount from "@graphql/public/types/scalar/cent-amount"

export const FygaroTopupStateEnum = GT.Enum({
  name: "FygaroTopupState",
  values: {
    PROCESSING: {
      value: "processing",
      description:
        "We have the payment and are crediting it. Not yet terminal — keep polling, " +
        "then fall back to telling the customer they will be notified.",
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
      type: GT.NonNull(CentAmount),
      description: "The amount this checkout was authorised for.",
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
