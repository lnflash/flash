import { GT } from "@graphql/index"

import IError from "@graphql/shared/types/abstract/error"
import CentAmount from "@graphql/public/types/scalar/cent-amount"
import USDCentsScalar from "@graphql/shared/types/scalar/usd-cents"

const CentAmountPayload = GT.Object({
  name: "CentAmountPayload",
  fields: () => ({
    errors: {
      type: GT.NonNullList(IError),
    },
    // the fee amount of the invoice 
    amount: {
      type: USDCentsScalar,
    },
    invoiceAmount: {
      type: USDCentsScalar,
    },
  }),
})

export default CentAmountPayload
