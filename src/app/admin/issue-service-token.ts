import { getAccount } from "@app/accounts"
import {
  daysToSeconds,
  validateExpirationDays,
  validateServiceAccount,
  SERVICE_TOKEN_TYPE,
  DEFAULT_SERVICE_TOKEN_DAYS
} from "@domain/authentication"
import { ErrorLevel, ValidationError } from "@domain/shared"
import { baseLogger } from "@services/logger"

import jsonwebtoken from "jsonwebtoken"

type TokenIssueResult = {
  token: string
}

export const issueServiceToken = async ({
  accountId,
  description,
  expiresIn = DEFAULT_SERVICE_TOKEN_DAYS,
}: {
  accountId: AccountId
  description: string
  expiresIn?: number
}): Promise<TokenIssueResult | ApplicationError> => {
  const logger = baseLogger.child({
    topic: "issue-service-token",
    accountId,
  })

  // Validate days parameter
  const validationResult = validateExpirationDays(expiresIn)
  if (validationResult instanceof ValidationError) {
    return validationResult
  }

  // Convert days to seconds for JWT
  const expiresInSeconds = daysToSeconds(expiresIn)

  // Get account to validate and retrieve kratosUserId
  const account = await getAccount(accountId)
  if (account instanceof Error) {
    return account
  }

  // Verify this is a service account
  const serviceValidation = validateServiceAccount(account.isServiceAccount)
  if (serviceValidation instanceof Error) {
    return serviceValidation
  }

  try {
    // Generate JWT with service token type
    const secret = process.env.JWT_SECRET
    if (!secret) {
      logger.error({ error: "Missing JWT secret" }, "JWT secret not configured")
      return new ValidationError("JWT secret not configured")
    }

    const token = jsonwebtoken.sign(
      {
        sub: account.kratosUserId,
        type: SERVICE_TOKEN_TYPE,
        description,
      },
      secret,
      {
        expiresIn: expiresInSeconds,
      },
    )

    logger.info({
      success: true,
      accountId: account.id,
      userId: account.kratosUserId,
      expiresIn,
    }, "Service token issued")

    return { token }
  } catch (error) {
    logger.error({ error }, "Failed to issue service token")
    return new ValidationError("Token generation failed")
  }
}