import { GT } from "@graphql/index"
import { extractErrorMessageFromError } from "@graphql/error"
import { mapError } from "@graphql/error-map"
import ServiceTokenPayload from "@graphql/admin/types/payload/service-token"

import { DEFAULT_SERVICE_TOKEN_DAYS } from "@domain/authentication"
import { Admin } from "@app"

export const IssueServiceTokenInput = GT.Input({
  name: "IssueServiceTokenInput",
  fields: () => ({
    accountId: {
      type: GT.NonNull(GT.ID),
      description: "Account ID for which to issue a service token",
    },
    description: {
      type: GT.NonNull(GT.String),
      description: "Description of the service token for audit purposes",
    },
    expiresIn: {
      type: GT.NonNull(GT.Int),
      description: "Number of days until the token expires",
      defaultValue: DEFAULT_SERVICE_TOKEN_DAYS,
    },
  }),
})


const IssueServiceTokenMutation = {
  type: GT.NonNull(ServiceTokenPayload),
  args: {
    input: { type: GT.NonNull(IssueServiceTokenInput) },
  },
  resolve: async (_: unknown, { input }: { input: any }, { logger }: { logger: Logger }) => {
    const { accountId, description, expiresIn } = input

    try {
      logger.info({ accountId, expiresIn }, "Issuing service token")

      const result = await Admin.issueServiceToken({
        accountId: accountId as AccountId,
        description,
        expiresIn,
      })

      if (result instanceof Error) {
        const errMsg = extractErrorMessageFromError(result)
        logger.error({ error: result }, `Failed to issue service token: ${errMsg}`)
        const gqlError = mapError(result)
        return {
          errors: [gqlError],
          token: null,
        }
      }

      return {
        errors: [],
        token: result.token,
      }
    } catch (error: unknown) {
      const err = error as Error
      logger.error({ error: err }, "Failed to issue service token")
      return {
        errors: [{ message: err.message || "Unknown error occurred" }],
        token: null,
      }
    }
  },
}

export default IssueServiceTokenMutation