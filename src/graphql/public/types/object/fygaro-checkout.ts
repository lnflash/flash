import { GT } from "@graphql/index"
import CentAmount from "@graphql/public/types/scalar/cent-amount"
import Timestamp from "@graphql/shared/types/scalar/timestamp"

const FygaroCheckout = GT.Object({
  name: "FygaroCheckout",
  description:
    "A server-authorised card top-up. The amount is signed into the URL, so it is " +
    "the only amount that can be paid through it.",
  fields: () => ({
    url: {
      type: GT.NonNull(GT.String),
      description:
        "Open this in the payment webview. The amount and the destination account are " +
        "signed into it and cannot be edited; it stops working at expiresAt.",
    },
    expiresAt: {
      type: GT.NonNull(Timestamp),
      description:
        "After this, the URL is rejected by the payment provider and a new one must be requested.",
    },
    amount: {
      type: GT.NonNull(CentAmount),
      description:
        "The authorised amount, echoed back so the client can display what was signed.",
    },
  }),
})

export default FygaroCheckout
