import { GT } from "@graphql/index"

import IError from "../../../shared/types/abstract/error"
import ConsumerAccount from "../object/consumer-account"

const AccountUpdateLnurlpPayload = GT.Object({
  name: "AccountUpdateLnurlpPayload",
  fields: () => ({
    errors: {
      type: GT.NonNullList(IError),
    },
    account: {
      type: ConsumerAccount,
    },
  }),
})

export default AccountUpdateLnurlpPayload
