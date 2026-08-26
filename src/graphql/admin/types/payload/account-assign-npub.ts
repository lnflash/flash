import { GT } from "@graphql/index"
import IError from "@graphql/shared/types/abstract/error"

import GraphQLAccount from "../object/account"

// `accountDetails` carries the npub this time (unlike the release payload,
// where the key has just been taken off), so the operator can confirm from the
// response alone that the key landed on the intended account.
const AccountAssignNpubPayload = GT.Object({
  name: "AccountAssignNpubPayload",
  fields: () => ({
    errors: {
      type: GT.List(IError),
    },
    accountDetails: {
      type: GraphQLAccount,
    },
  }),
})

export default AccountAssignNpubPayload
