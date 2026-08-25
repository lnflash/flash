import { GT } from "@graphql/index"
import IError from "@graphql/shared/types/abstract/error"

import GraphQLAccount from "../object/account"

// Not `AccountDetailPayload`: `accountDetails` is the account the key was taken
// off, so it no longer carries the npub, and nothing else in the response says
// which key was freed or where it went.
const AccountReleaseNpubPayload = GT.Object({
  name: "AccountReleaseNpubPayload",
  fields: () => ({
    errors: {
      type: GT.List(IError),
    },
    accountDetails: {
      type: GraphQLAccount,
    },
    previousNpub: {
      type: GT.String,
    },
    reassignedTo: {
      type: GraphQLAccount,
    },
  }),
})

export default AccountReleaseNpubPayload
