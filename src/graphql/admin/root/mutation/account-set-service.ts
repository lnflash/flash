import { GT } from "@graphql/index"
import { extractErrorMessageFromError } from "@graphql/error"
import { mapError } from "@graphql/error-map"
import AccountDetailPayload from "@graphql/admin/types/payload/account-detail"

import { Admin } from "@app"

export const AccountSetServiceInput = GT.Input({
  name: "AccountSetServiceInput",
  fields: () => ({
    accountId: {
      type: GT.NonNull(GT.ID),
      description: "Account ID to set service account status for",
    },
    isServiceAccount: {
      type: GT.NonNull(GT.Boolean),
      description: "Whether the account should be a service account",
    },
  }),
})

const AccountSetServiceMutation = {
  type: GT.NonNull(AccountDetailPayload),
  args: {
    input: { type: GT.NonNull(AccountSetServiceInput) },
  },
  resolve: async (_: unknown, { input }: { input: any }, { logger }: { logger: Logger }) => {
    const { accountId, isServiceAccount } = input

    try {
      logger.info(
        { accountId, isServiceAccount },
        "Setting account service status",
      )

      const result = await Admin.setAccountService({
        accountId: accountId as AccountId,
        isServiceAccount,
      })

      if (result instanceof Error) {
        const errMsg = extractErrorMessageFromError(result)
        logger.error(
          { error: result },
          `Failed to set account service status: ${errMsg}`,
        )
        const gqlError = mapError(result)
        return {
          errors: [gqlError],
          accountDetails: null,
        }
      }

      return {
        errors: [],
        accountDetails: {
          id: result.id,
          kratosUserId: result.kratosUserId,
          username: result.username,
          level: result.level,
          status: result.status,
          uuid: result.uuid,
          isServiceAccount: result.isServiceAccount,
          createdAt: result.createdAt,
          owner: {
            id: result.kratosUserId,
            phone: null,
            email: null,
            language: "",
            createdAt: result.createdAt,
          },
          wallets: [],
          merchants: [],
          npub: result.npub,
          title: result.title,
          coordinates: result.coordinates,
        },
      }
    } catch (error: unknown) {
      const err = error as Error
      logger.error({ error: err }, "Failed to set account service status")
      return {
        errors: [{ message: err.message || "Unknown error occurred" }],
        accountDetails: null,
      }
    }
  },
}

export default AccountSetServiceMutation