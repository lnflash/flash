import DataLoader from "dataloader"

import { Accounts, Transactions } from "@app"
import { recordExceptionInCurrentSpan } from "@services/tracing"
import jsonwebtoken from "jsonwebtoken"

import { mapError } from "@graphql/error-map"

import { maybeExtendSession } from "@app/authentication"
import { checkedToUserId } from "@domain/accounts"
import { ValidationError } from "@domain/shared"
import { baseLogger } from "@services/logger"
import { UsersRepository } from "@services/mongoose"
import { IbexError } from "@services/ibex/errors"

// Import API token authentication functions
import { validateApiToken, getApiTokenAccountContext } from "./api-token-auth"

// Helper function to create data loaders
const createDataLoaders = () => {
  const loaders = {
    txnMetadata: new DataLoader(async (keys) => {
      const txnMetadata = await Transactions.getTransactionsMetadataByIds(
        keys as LedgerTransactionId[],
      )
      if (txnMetadata instanceof IbexError) {
        recordExceptionInCurrentSpan({
          error: txnMetadata,
        })
        return keys.map(() => undefined)
      }
      else if (txnMetadata instanceof Error) {
        recordExceptionInCurrentSpan({
          error: txnMetadata,
          level: txnMetadata.level,
        })

        return keys.map(() => undefined)
      }

      return txnMetadata
    }),
  }
  return loaders
}

export const sessionPublicContext = async (
  params: {
    tokenPayload?: jsonwebtoken.JwtPayload
    ip: IpAddress | undefined
    authHeader?: string // Add support for Authorization header
  }
): Promise<GraphQLPublicContext> => {
  const { tokenPayload, ip, authHeader } = params
  
  // First, try API token authentication
  if (authHeader) {
    const apiTokenAuth = await validateApiToken(authHeader)
    if (apiTokenAuth) {
      const context = await getApiTokenAccountContext(apiTokenAuth)
      if (context) {
        const logger = baseLogger.child({ apiTokenId: apiTokenAuth.tokenId })
        
        // Return context with API token information
        return {
          logger,
          loaders: createDataLoaders(),
          user: undefined, // API tokens don't have user context
          domainAccount: context.domainAccount,
          ip,
          sessionId: undefined,
          isApiToken: true,
          apiTokenScopes: context.apiTokenScopes,
          apiTokenId: context.apiTokenId
        }
      }
    }
  }
  
  // Fall back to existing Kratos session authentication
  if (!tokenPayload) {
    // No authentication provided
    return {
      logger: baseLogger,
      loaders: createDataLoaders(),
      user: undefined,
      domainAccount: undefined,
      ip,
      sessionId: undefined
    }
  }
  
  const logger = baseLogger.child({ tokenPayload })

  let domainAccount: Account | undefined
  let user: User | undefined

  const sessionId = tokenPayload?.session_id
  const expiresAt = tokenPayload?.expires_at

  // note: value should match (ie: "anon") if not an accountId
  // settings from dev/ory/oathkeeper.yml/authenticator/anonymous/config/subjet
  const maybeUserId = checkedToUserId(tokenPayload?.sub ?? "")

  if (!(maybeUserId instanceof ValidationError)) {
    const userId = maybeUserId
    const account = await Accounts.getAccountFromUserId(userId)
    if (account instanceof Error) {
      throw mapError(account)
    } else {
      domainAccount = account
      // not awaiting on purpose. just updating metadata
      // TODO: look if this can be a source of memory leaks
      Accounts.updateAccountIPsInfo({
        accountId: account.id,
        ip,
        logger,
      })

      if (sessionId && expiresAt) {
        maybeExtendSession({ sessionId, expiresAt })
      }

      const userRes = await UsersRepository().findById(account.kratosUserId)
      if (userRes instanceof Error) throw mapError(userRes)
      user = userRes
    }
  }

  return {
    logger,
    loaders: createDataLoaders(),
    user,
    domainAccount,
    ip,
    sessionId,
  }
}
