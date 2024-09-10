import { GT } from "@graphql/index"

import { mapError } from "@graphql/error-map"

import { Accounts } from "@app"
import Username from "@graphql/shared/types/scalar/username"
import npubByUsername from "@graphql/public/types/object/npub-by-username"

const NpubByUserNameQuery = GT.Field({
  type: npubByUsername,
  args: {
    username: {
      type: GT.NonNull(Username),
    },
  },
  resolve: async (_, args) => {
    const { username } = args
    console.log("INSIIIIIIIDE")
    if (username instanceof Error) {
      throw username
    }
    console.log("username error?", username)
    const output = await Accounts.npubByUsername(username)
    console.log("output?", output)
    return output
  },
})

export default NpubByUserNameQuery
