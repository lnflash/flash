import { Accounts } from "@app"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import { GT } from "@graphql/index"

import UserUpdateNpubPayload from "@graphql/public/types/payload/user-update-npub"
import Npub from "@graphql/shared/types/scalar/npub"

const UserUpdateNpubInput = GT.Input({
  name: "UserUpdateNpubInput",
  fields: () => ({
    npub: { type: GT.NonNull(Npub) },
  }),
})

const UserUpdateNpubMutation = GT.Field({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(UserUpdateNpubPayload),
  args: {
    input: { type: GT.NonNull(UserUpdateNpubInput) },
  },
  resolve: async (_, args, { domainAccount }: GraphQLPublicContextAuth) => {
    const { npub } = args.input
    console.log(
      "INSIDE NPUb UPDATE +________________________________________________________+",
    )

    if (npub instanceof Error) {
      return { errors: [{ message: npub.message }] }
    }

    const result = await Accounts.setNpub({ npub, id: domainAccount.id })
    console.info(
      "RESULT OF NPUb UPDATE +________________________________________________________+",
      result,
    )
    if (result instanceof Error) {
      return {
        errors: [mapAndParseErrorForGqlResponse(result)],
      }
    }

    return {
      errors: [],
      user: result,
    }
  },
})

export default UserUpdateNpubMutation
