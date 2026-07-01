import { GT } from "@graphql/index"

import { Accounts } from "@app"
import npubByUsername from "@graphql/public/types/object/npub-by-username"
import Username from "@graphql/shared/types/scalar/username"

const NpubByUserNameQuery = GT.Field({
  type: npubByUsername,
  args: {
    username: {
      type: GT.NonNull(Username),
    },
  },
  resolve: async (_, args) => {
    const { username } = args
    if (username instanceof Error) {
      throw username
    }
    const output = await Accounts.npubByUsername(username)
    return output
  },
})

export default NpubByUserNameQuery
