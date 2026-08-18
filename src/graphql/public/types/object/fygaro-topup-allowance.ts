import { GT } from "@graphql/index"
import CentAmount from "@graphql/public/types/scalar/cent-amount"
import Timestamp from "@graphql/shared/types/scalar/timestamp"

const FygaroTopupAllowance = GT.Object({
  name: "FygaroTopupAllowance",
  description:
    "How much of today's card top-up allowance this account has left. Read-only — " +
    "safe to call while the customer is still choosing an amount.",
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
    remaining: {
      type: GT.NonNull(CentAmount),
      description: "What would still be accepted right now. Never negative.",
    },
    resetsAt: {
      type: Timestamp,
      description:
        "When the oldest counted payment ages out and allowance returns. Null when " +
        "nothing is counted, i.e. the full limit is already available.",
    },
  }),
})

export default FygaroTopupAllowance
