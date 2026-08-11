import dedent from "dedent"
import { GT } from "@graphql/index"

// Fee parameters the mobile app needs to preview "you'll receive $X" locally
// before a Fygaro card top-up. Sourced from the ERPNext "Fygaro Settings"
// doctype (through the webhook's 60s cache). All amounts are in USD; percents
// are whole-number percents (e.g. 2.99 means 2.99%).
const FygaroTopupInfo = GT.Object({
  name: "FygaroTopupInfo",
  description: dedent`Fee parameters for Fygaro card top-ups, so the client can
    compute the net amount a user will receive. Null when the operator settings
    are unavailable — clients should degrade gracefully (hide the estimate).`,
  fields: () => ({
    minimumAmount: {
      type: GT.NonNull(GT.Float),
      description: "Minimum top-up amount, in USD.",
    },
    processorFeePercent: {
      type: GT.NonNull(GT.Float),
      description: "Payment-processor percentage fee (e.g. 2.99 = 2.99%).",
    },
    processorFeeFixed: {
      type: GT.NonNull(GT.Float),
      description: "Payment-processor fixed fee, in USD.",
    },
    flashFeePercent: {
      type: GT.NonNull(GT.Float),
      description: "Flash margin percentage fee (e.g. 2.0 = 2.0%).",
    },
    flashFeeFixed: {
      type: GT.NonNull(GT.Float),
      description: "Flash margin fixed fee, in USD.",
    },
  }),
})

export default FygaroTopupInfo
