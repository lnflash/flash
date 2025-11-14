import { GT } from "@graphql/index"
import EmailAddress from "@graphql/shared/types/scalar/email-address"
import { Authentication } from "@app"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import IError from "@graphql/shared/types/abstract/error"

const NewUserEmailRegistrationInitiateInput = GT.Input({
  name: "NewUserEmailRegistrationInitiateInput",
  fields: () => ({
    email: {
      type: GT.NonNull(EmailAddress),
    },
  }),
})

const NewUserEmailRegistrationInitiatePayload = GT.Object({
  name: "NewUserEmailRegistrationInitiatePayload",
  fields: () => ({
    errors: { type: GT.NonNull(GT.List(GT.NonNull(IError))) },
    emailFlowId: { type: GT.String },
  }),
})

const NewUserEmailRegistrationInitiateMutation = GT.Field<
  null,
  GraphQLPublicContext,
  {
    input: {
      email: EmailAddress | InputValidationError
    }
  }
>({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(NewUserEmailRegistrationInitiatePayload),
  args: {
    input: { type: GT.NonNull(NewUserEmailRegistrationInitiateInput) },
  },
  resolve: async (_, args, { ip }) => {
    const { email } = args.input

    if (email instanceof Error) {
      return { errors: [{ message: email.message }] }
    }

    if (ip === undefined) {
      return { errors: [{ message: "ip is undefined" }] }
    }

    const flowId = await Authentication.requestEmailCode({
      email,
      ip,
    })

    if (flowId instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(flowId)] }
    }

    return { errors: [], emailFlowId: flowId }
  },
})

export default NewUserEmailRegistrationInitiateMutation