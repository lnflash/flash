import { Accounts } from "@app"
import { UsernameIsImmutableError } from "@domain/accounts"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import { GT } from "@graphql/index"

import UserUpdateUsernamePayload from "@graphql/public/types/payload/user-update-username"
import Username from "@graphql/shared/types/scalar/username"

import { IbexRoutes } from "../../../../services/IbexHelper/Routes"

import { requestIBexPlugin } from "../../../../services/IbexHelper/IbexHelper"

const UserUpdateUsernameInput = GT.Input({
  name: "UserUpdateUsernameInput",
  fields: () => ({
    username: { type: GT.NonNull(Username) },
  }),
})

const UserUpdateUsernameMutation = GT.Field({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(UserUpdateUsernamePayload),
  args: {
    input: { type: GT.NonNull(UserUpdateUsernameInput) },
  },
  deprecationReason:
    "Username will be moved to @Handle in Accounts. Also SetUsername naming should be used instead of UpdateUsername to reflect the idempotency of Handles",
  resolve: async (_, args, { domainAccount }: GraphQLContextAuth) => {
    const { username } = args.input

    if (username instanceof Error) {
      return { errors: [{ message: username.message }] }
    }

    const UpdateUserName = await requestIBexPlugin(
      "PUT",
      IbexRoutes.API_UpdateAccount + domainAccount.id,
      {},
      {
        name: username
      },
    )
    console.log("UpdateUserName", UpdateUserName)
    if (UpdateUserName) {
      const CreateLightning = await requestIBexPlugin(
        "POST",
        IbexRoutes.LightningAddress,
        {},
        {
          "accountId": domainAccount.id,
          // "accountId": "d988c334-4ee7-4184-8bb7-7b355a63137e",
          "username": username
        },
      )
      // console.log("CreateLightning", CreateLightning)
      if (CreateLightning && CreateLightning.data && CreateLightning.data["data"]["id"]) {
        const UpdateLightning = await requestIBexPlugin(
          "PUT",
          IbexRoutes.LightningAddress + CreateLightning.data["data"]["id"],
          {},
          {
            "username": username
          },
        )
        // console.log("UpdateLightning", UpdateLightning)
      }
    }

    const result = await Accounts.setUsername({ username, id: domainAccount.id })

    if (result instanceof Error) {
      return {
        errors: [mapAndParseErrorForGqlResponse(result)],

        // FIXME: what is this return for?
        ...(result instanceof UsernameIsImmutableError ? { user: domainAccount } : {}),
      }
    }

    return {
      errors: [],

      // TODO: move to accounts
      // TODO: username and id are not populated correctly (but those properties not been used currently by a client)
      user: UpdateUserName,
    }
  },
})

export default UserUpdateUsernameMutation
