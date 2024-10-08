import { GT } from "@graphql/index"

import IError from "../../../shared/types/abstract/error"
import GraphQLUser from "../object/user"

const UserUpdateUsernamePayload = GT.Object({
  name: "UserUpdateUsernamePayload",
  fields: () => ({
    errors: {
      type: GT.NonNullList(IError),
    },
    user: {
      type: GraphQLUser,
    },
  }),
})

export default UserUpdateUsernamePayload
