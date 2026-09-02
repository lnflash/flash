import { applyMiddleware } from "graphql-middleware"

import { GALOY_API_PORT } from "@config"

import { AuthorizationError } from "@graphql/error"
import { gqlMainSchema, mutationFields, queryFields } from "@graphql/public"

import { bootstrap } from "@app/bootstrap"
import { baseLogger } from "@services/logger"
import { setupMongoConnection } from "@services/mongodb"
import { and, shield } from "graphql-shield"
import { ShieldRule } from "graphql-shield/typings/types"
import { recordExceptionInCurrentSpan } from "@services/tracing"

import { apiKeyNestedFieldScopes } from "@domain/api-keys"
import { ErrorLevel } from "@domain/shared"

import { startApiKeyMetricsServer } from "./api-key-metrics"
import { startApolloServerForAdminSchema } from "./graphql-admin-server"
import {
  isAuthenticated,
  scopedApiKeyAccess,
  scopedApiKeyTypeField,
  startApolloServer,
} from "./graphql-server"
import { setGqlContext } from "./middlewares/gql-context"
import { walletIdMiddleware } from "./middlewares/wallet-id"

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
  // A rejected promise nobody awaits must be logged, not fatal: Node's default
  // `--unhandled-rejections=throw` exits the whole api replica on one stray
  // rejection (see setGqlContext for the 2026-09-01 crash loop).
  process.on("unhandledRejection", (reason) => {
    baseLogger.error({ reason }, "unhandledRejection")
    recordExceptionInCurrentSpan({
      error: reason,
      level: ErrorLevel.Critical,
      fallbackMsg: "unhandledRejection",
    })
  })

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
