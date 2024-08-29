import { GT } from "@graphql/index"

import IError from "../../../shared/types/abstract/error"
import GraphQLUser from "../object/user"

const UserUpdateNpubPayload = GT.Object({
  name: "UserUpdateNpubPayload",
  fields: () => ({
    errors: {
      type: GT.NonNullList(IError),
    },
    user: {
      type: GraphQLUser,
    },
  }),
})

export default UserUpdateNpubPayload
