import { GT } from "@graphql/index"

import GraphQLAccount from "@graphql/admin/types/object/account"
import Npub from "@graphql/shared/types/scalar/npub"
import { mapError } from "@graphql/error-map"

import { Admin } from "@app"

const AccountDetailsByNpubQuery = GT.Field({
  type: GT.NonNull(GraphQLAccount),
  args: {
    npub: { type: GT.NonNull(Npub) },
  },
  resolve: async (parent, { npub }) => {
    if (npub instanceof Error) {
      throw npub
    }

    const account = await Admin.getAccountByNpub(npub)
    if (account instanceof Error) {
      throw mapError(account)
    }

    return account
  },
})

export default AccountDetailsByNpubQuery
