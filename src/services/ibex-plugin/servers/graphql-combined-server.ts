import dotenv from "dotenv"
import { applyMiddleware } from "graphql-middleware"
import { shield } from "graphql-shield"
import { Rule } from "graphql-shield/typings/rules"

import { baseLogger } from "@services/logger"
import { setupMongoConnection } from "@services/mongodb"

import { activateLndHealthCheck } from "@services/lnd/health"

import { GALOY_IBEX_PORT } from "@config"
import { mutationFields, queryFields } from "@graphql/main"

import schemaWithResolvers from "../typeDefs/extendSchema"

import { startApolloServer, isAuthenticated } from "../../../servers/graphql-server"
import { walletIdMiddleware } from "../../../servers/middlewares/wallet-id"

dotenv.config()

const graphqlLogger = baseLogger.child({ module: "graphql" })

export async function startApolloServerForCombinedSchema() {
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

  const permissions = shield(
    {
      Query: authedQueryFields,
      Mutation: authedMutationFields,
    },
    { allowExternalErrors: true },
  )

  const schema = applyMiddleware(schemaWithResolvers, permissions, walletIdMiddleware)
  return startApolloServer({ schema, port: GALOY_IBEX_PORT, type: "ibex" })
}

if (require.main === module) {
  setupMongoConnection()
    .then(async () => {
      activateLndHealthCheck()
      await startApolloServerForCombinedSchema()
    })
    .catch((err) => graphqlLogger.error(err, "server error"))
}
