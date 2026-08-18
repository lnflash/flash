import { GT } from "@graphql/index"
import CentAmount from "@graphql/public/types/scalar/cent-amount"
import Timestamp from "@graphql/shared/types/scalar/timestamp"

const FygaroTopupAllowance = GT.Object({
  name: "FygaroTopupAllowance",
  description:
    "How much of today's card top-up allowance this account has left. Does not " +
    "authorise anything, so it is safe to call while the customer is still choosing " +
    "an amount. Render all four: `remaining` is the cap less BOTH `spent` and `held`, " +
    "so without those two the gap cannot be explained. It is floored at zero and can " +
    "therefore be smaller than `limit - spent - held` — an account can exceed its cap " +
    "via a hand-credit, or via spend recorded before a limit change.",
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
        "What would still be accepted right now: the cap less BOTH `spent` and `held`. " +
        "Unpaid checkout links are already subtracted, exactly as the pre-charge check " +
        "subtracts them, so this is what a new top-up would be measured against — not " +
        "`limit - spent`. Never negative.",
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

export default FygaroTopupAllowance
