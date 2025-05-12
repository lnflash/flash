import { applyMiddleware } from "graphql-middleware"

import { GALOY_API_PORT, UNSECURE_IP_FROM_REQUEST_OBJECT } from "@config"

import { AuthorizationError } from "@graphql/error"
import { gqlMainSchema, mutationFields, queryFields } from "@graphql/public"
import { apiKeyQueryRules, apiKeyMutationRules, apiKeySubscriptionRules } from "@graphql/public/permissions/api-key-permissions"
import { getContextFromRequest } from "@graphql/public/context"

import { bootstrap } from "@app/bootstrap"
import { activateLndHealthCheck } from "@services/lnd/health"
import { baseLogger } from "@services/logger"
import { setupMongoConnection } from "@services/mongodb"
import { shield, or } from "graphql-shield"
import { Rule, RuleOr } from "graphql-shield/typings/rules"
import {
  ACCOUNT_USERNAME,
  SemanticAttributes,
  addAttributesToCurrentSpanAndPropagate,
} from "@services/tracing"

import { NextFunction, Request, Response } from "express"

import { parseIps } from "@domain/accounts-ips"

import { startApolloServerForAdminSchema } from "./graphql-admin-server"
import { isAuthenticated, startApolloServer } from "./graphql-server"
import { walletIdMiddleware } from "./middlewares/wallet-id"
import { apiKeyAuthMiddleware } from "./middlewares/api-key-auth"

import { sessionPublicContext } from "./middlewares/session"

const setGqlContext = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const tokenPayload = req.token

  const ipString = UNSECURE_IP_FROM_REQUEST_OBJECT
    ? req.ip
    : req.headers["x-real-ip"] || req.headers["x-forwarded-for"]

  const ip = parseIps(ipString)

  // Create context from session
  const sessionContext = await sessionPublicContext({
    tokenPayload,
    ip,
  })

  // Create context with API key info if present
  const apiKeyContext = await getContextFromRequest(req)

  // Combine contexts
  // Explicitly type and merge the contexts to ensure compatibility
  const gqlContext: GraphQLPublicContext = {
    ...sessionContext,
    apiKey: apiKeyContext.apiKey,
  }

  // Type assertion to help TypeScript understand this is valid
  req.gqlContext = gqlContext as GraphQLPublicContext | GraphQLAdminContext

  return addAttributesToCurrentSpanAndPropagate(
    {
      "token.iss": tokenPayload?.iss,
      "token.session_id": tokenPayload?.session_id,
      "token.expires_at": tokenPayload?.expires_at,
      [SemanticAttributes.HTTP_CLIENT_IP]: ip,
      [SemanticAttributes.HTTP_USER_AGENT]: req.headers["user-agent"],
      // Only include username if it's an actual Account object with username property
      [ACCOUNT_USERNAME]: "username" in (gqlContext?.domainAccount || {})
        ? (gqlContext?.domainAccount as any)?.username
        : undefined,
      [SemanticAttributes.ENDUSER_ID]: tokenPayload?.sub,
    },
    next,
  )
}

export async function startApolloServerForCoreSchema() {
  const authedQueryFields: { [key: string]: Rule } = {}
  for (const key of Object.keys({
    ...queryFields.authed.atAccountLevel,
    ...queryFields.authed.atWalletLevel,
  })) {
    authedQueryFields[key] = isAuthenticated
  }

  const authedMutationFields: { [key: string]: Rule } = {}
  for (const key of Object.keys({
    ...mutationFields.authed.atAccountLevel,
    ...mutationFields.authed.atWalletLevel,
  })) {
    authedMutationFields[key] = isAuthenticated
  }

  // Create permission rules combining JWT auth with API key auth
  const queryRules: Record<string, Rule | RuleOr> = {}
  const mutationRules: Record<string, Rule | RuleOr> = {}

  // Process query fields
  for (const key of Object.keys({
    ...queryFields.authed.atAccountLevel,
    ...queryFields.authed.atWalletLevel,
  })) {
    // Only add OR rules for operations that have API key rules
    if (Object.prototype.hasOwnProperty.call(apiKeyQueryRules, key)) {
      // Type assertion needed for TypeScript
      const typedKey = key as keyof typeof apiKeyQueryRules;
      queryRules[key] = or(isAuthenticated, apiKeyQueryRules[typedKey]);
    } else {
      queryRules[key] = isAuthenticated;
    }
  }

  // Process mutation fields
  for (const key of Object.keys({
    ...mutationFields.authed.atAccountLevel,
    ...mutationFields.authed.atWalletLevel,
  })) {
    // Only add OR rules for operations that have API key rules
    if (Object.prototype.hasOwnProperty.call(apiKeyMutationRules, key)) {
      // Type assertion needed for TypeScript
      const typedKey = key as keyof typeof apiKeyMutationRules;
      mutationRules[key] = or(isAuthenticated, apiKeyMutationRules[typedKey]);
    } else {
      mutationRules[key] = isAuthenticated;
    }
  }

  // Create combined permissions
  const combinedPermissions = shield(
    {
      Query: queryRules,
      Mutation: mutationRules,
    },
    {
      allowExternalErrors: true,
      fallbackError: new AuthorizationError({ logger: baseLogger }),
    },
  )

  const schema = applyMiddleware(gqlMainSchema, combinedPermissions, walletIdMiddleware)
  return startApolloServer({
    schema,
    port: GALOY_API_PORT,
    type: "main",
    setGqlContext,
  })
}

if (require.main === module) {
  setupMongoConnection(true)
    .then(async () => {
      // activateLndHealthCheck() // 

      const res = await bootstrap()
      if (res instanceof Error) throw res

      await Promise.race([
        startApolloServerForCoreSchema(),
        startApolloServerForAdminSchema(),
      ])
    })
    .catch((err) => baseLogger.error(err, "server error"))
}
