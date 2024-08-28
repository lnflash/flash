import { GT } from "@graphql/index"
import IError from "@graphql/shared/types/abstract/error"

import Merchant from "../object/merchant"

const MerchantPayload = GT.Object({
  name: "MerchantPayload",
  fields: () => ({
    errors: {
      type: GT.NonNullList(IError),
    },
    merchant: {
      type: Merchant,
    },
  }),
})

export default MerchantPayload
