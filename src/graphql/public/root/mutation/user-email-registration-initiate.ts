import { GT } from "@graphql/index"

import { Authentication } from "@app"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import EmailAddress from "@graphql/shared/types/scalar/email-address"
import UserEmailRegistrationInitiatePayload from "@graphql/public/types/payload/user-email-registration-initiate"

import { IbexRoutes } from "../../../../services/IbexHelper/Routes"

import { requestIBexPlugin } from "../../../../services/IbexHelper/IbexHelper"

const UserEmailRegistrationInitiateInput = GT.Input({
  name: "UserEmailRegistrationInitiateInput",
  fields: () => ({
    email: {
      type: GT.NonNull(EmailAddress),
    },
  }),
})

const UserEmailRegistrationInitiateMutation = GT.Field<
  {
    input: {
      email: EmailAddress | InputValidationError
    }
  },
  null,
  GraphQLContextAuth
>({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(UserEmailRegistrationInitiatePayload),
  args: {
    input: { type: GT.NonNull(UserEmailRegistrationInitiateInput) },
  },
  resolve: async (_, args, { user }) => {
    const { email } = args.input

    if (email instanceof Error) {
      return { errors: [{ message: email.message }] }
    }

    const res = await Authentication.addEmailToIdentity({
      email,
      userId: user.id,
    })

    if (res instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(res)], success: false }
    }

    const CreationResponse = await requestIBexPlugin(
      "POST",
      IbexRoutes.API_CreateAccount,
      {},
      {
        name: "testOne",
        currencyId: 3
      },
    )
    console.log("CreationResponse", CreationResponse)

    const { data } = CreationResponse;

    let { me } = res
    let accountId = CreationResponse.data && CreationResponse.data["data"]["id"] ? CreationResponse.data["data"]["id"] : "";
    console.log("accountId", accountId)
    let emailRegistrationId = accountId
    // me.email.address = accountId
    return { errors: [], emailRegistrationId, me }
  },
})

export default UserEmailRegistrationInitiateMutation
