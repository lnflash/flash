import { GT } from "@graphql/index"
import OneTimeAuthCode from "@graphql/shared/types/scalar/one-time-auth-code"
import AuthTokenPayload from "@graphql/shared/types/payload/auth-token"
import { Authentication, Accounts } from "@app"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import { AuthWithEmailPasswordlessService } from "@services/kratos"
import { AccountsRepository } from "@services/mongoose"
import { getDefaultAccountsConfig } from "@config"

const NewUserEmailRegistrationValidateInput = GT.Input({
  name: "NewUserEmailRegistrationValidateInput",
  fields: () => ({
    emailFlowId: {
      type: GT.NonNull(GT.String),
    },
    code: {
      type: GT.NonNull(OneTimeAuthCode),
    },
  }),
})

const NewUserEmailRegistrationValidateMutation = GT.Field<
  null,
  GraphQLPublicContext,
  {
    input: {
      emailFlowId: string
      code: EmailCode | InputValidationError
    }
  }
>({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(AuthTokenPayload),
  args: {
    input: { type: GT.NonNull(NewUserEmailRegistrationValidateInput) },
  },
  resolve: async (_, args, { ip }) => {
    const { emailFlowId, code } = args.input

    if (code instanceof Error) {
      return { errors: [{ message: code.message }] }
    }

    if (ip === undefined) {
      return { errors: [{ message: "ip is undefined" }] }
    }

    // Validate the code with Kratos
    const authService = AuthWithEmailPasswordlessService()
    const validateResult = await authService.validateCode({
      emailFlowId: emailFlowId as EmailFlowId,
      code,
    })

    if (validateResult instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(validateResult)] }
    }

    const { email, kratosUserId, totpRequired } = validateResult

    // Check if account exists, if not create it
    const accountsRepo = AccountsRepository()
    let account = await accountsRepo.findByUserId(kratosUserId)

    if (account instanceof Error) {
      // Account doesn't exist, create new account
      const config = getDefaultAccountsConfig()
      const accountResult = await Accounts.createAccountWithEmailIdentifier({
        newAccountInfo: { kratosUserId, email },
        config,
      })

      if (accountResult instanceof Error) {
        return { errors: [mapAndParseErrorForGqlResponse(accountResult)] }
      }
    }

    // Login with email to get auth token
    const loginResult = await authService.loginToken({ email })

    if (loginResult instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(loginResult)] }
    }

    const { authToken } = loginResult

    return { errors: [], authToken, totpRequired }
  },
})

export default NewUserEmailRegistrationValidateMutation
