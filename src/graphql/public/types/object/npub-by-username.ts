import { GT } from "@graphql/index"
import Username from "../../../shared/types/scalar/username"
import Npub from "@graphql/shared/types/scalar/npub"

const npubByUsername = GT.Object<User, GraphQLPublicContextAuth>({
  name: "npubByUsername",
  fields: () => ({
    username: {
      type: Username,
      description: "Optional immutable user friendly identifier.",
    },
    npub: {
      type: Npub,
      description: "Nostr public key",
    },
  }),
})

export default npubByUsername
