import { GT } from "@graphql/index"

import FractionalCentAmount from "../scalar/cent-amount-fraction"

const OnChainUsdTxFee = GT.Object({
  name: "OnChainUsdTxFee",
  fields: () => ({
    amount: { type: GT.NonNull(FractionalCentAmount) },
  }),
})

export default OnChainUsdTxFee
