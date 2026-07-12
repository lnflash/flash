import { applyMiddleware } from "graphql-middleware"

import { GALOY_API_PORT, UNSECURE_IP_FROM_REQUEST_OBJECT } from "@config"

import { AuthorizationError } from "@graphql/error"
import { gqlMainSchema, mutationFields, queryFields } from "@graphql/public"

import { bootstrap } from "@app/bootstrap"
import { baseLogger } from "@services/logger"
import { setupMongoConnection } from "@services/mongodb"
import { and, shield } from "graphql-shield"
import { ShieldRule } from "graphql-shield/typings/types"
import {
  ACCOUNT_USERNAME,
  SemanticAttributes,
  addAttributesToCurrentSpanAndPropagate,
} from "@services/tracing"

import { NextFunction, Request, Response } from "express"

import { parseIps } from "@domain/accounts-ips"
import { apiKeyNestedFieldScopes } from "@domain/api-keys"
import { parseCashWalletClientCapabilities } from "@app/cash-wallet-cutover/client-capability"

import { startApiKeyMetricsServer } from "./api-key-metrics"
import { startApolloServerForAdminSchema } from "./graphql-admin-server"
import {
  isAuthenticated,
  scopedApiKeyAccess,
  scopedApiKeyTypeField,
  startApolloServer,
} from "./graphql-server"
import { walletIdMiddleware } from "./middlewares/wallet-id"

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

  const gqlContext = await sessionPublicContext({
    tokenPayload,
    ip,
  })
  const cashWalletClientCapabilities = parseCashWalletClientCapabilities(req.headers)

  req.gqlContext = {
    ...gqlContext,
    cashWalletClientCapabilities,
  }

  return addAttributesToCurrentSpanAndPropagate(
    {
      "token.iss": tokenPayload?.iss,
      "token.session_id": tokenPayload?.session_id,
      "token.expires_at": tokenPayload?.expires_at,
      [SemanticAttributes.HTTP_CLIENT_IP]: ip,
      [SemanticAttributes.HTTP_USER_AGENT]: req.headers["user-agent"],
      [ACCOUNT_USERNAME]: gqlContext?.domainAccount?.username,
      [SemanticAttributes.ENDUSER_ID]: tokenPayload?.sub,
      "cash_wallet.client_presentation":
        cashWalletClientCapabilities.cashWalletPresentation,
      "cash_wallet.client_usdt_supported": String(
        cashWalletClientCapabilities.hasUsdtCashWalletSupport,
      ),
    },
    next,
  )
}

export async function startApolloServerForCoreSchema() {
  const authedQueryFields: { [key: string]: ShieldRule } = {}
  for (const key of Object.keys({
    ...queryFields.authed.atAccountLevel,
    ...queryFields.authed.atWalletLevel,
  })) {
    authedQueryFields[key] = and(isAuthenticated, scopedApiKeyAccess(key))
  }

  const authedMutationFields: { [key: string]: ShieldRule } = {}
  for (const key of Object.keys({
    ...mutationFields.authed.atAccountLevel,
    ...mutationFields.authed.atWalletLevel,
  })) {
    authedMutationFields[key] = and(isAuthenticated, scopedApiKeyAccess(key))
  }

  // FIP-07 nested-field guard: a root-level grant (e.g. me → read:user) must not
  // expose wallet balances or transaction history through nested resolvers.
  // These type-level rules gate the wallet/transaction entry fields reachable
  // through an authed root field; non-API-key sessions pass through and the root
  // field already enforced isAuthenticated. The field→scope table lives in
  // @domain/api-keys (apiKeyNestedFieldScopes) so a completeness test can assert
  // every sensitive field is covered.
  const nestedTypeRules = Object.fromEntries(
    Object.entries(apiKeyNestedFieldScopes).map(([typeName, fieldScopes]) => [
      typeName,
      Object.fromEntries(
        Object.entries(fieldScopes).map(([field, scope]) => [
          field,
          scopedApiKeyTypeField(scope),
        ]),
      ),
    ]),
  )

  const permissions = shield(
    {
      Query: authedQueryFields,
      Mutation: authedMutationFields,
      ...nestedTypeRules,
    },
    {
      allowExternalErrors: true,
      fallbackError: new AuthorizationError({ logger: baseLogger }),
    },
  )

  const schema = applyMiddleware(gqlMainSchema, permissions, walletIdMiddleware)
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
      // activateLndHealthCheck()

      await bootstrap()
      // if (res instanceof Error) throw res

      await Promise.race([
        startApolloServerForCoreSchema(),
        startApolloServerForAdminSchema(),
      ])

      // FIP-07 (ENG-103): per-pod prometheus listener for the API key
      // counters. Main API entrypoint only — the admin/ws/trigger/exporter
      // processes must never bind this port.
      startApiKeyMetricsServer()
    })
    .catch((err) => baseLogger.error(err, "server error"))
}
