import { createServer } from "http"

import express, { NextFunction, Request, Response } from "express"

import { getJwksArgs } from "@config"
import { baseLogger } from "@services/logger"
import { ApolloServerPluginDrainHttpServer } from "apollo-server-core"
import { ApolloError, ApolloServer } from "apollo-server-express"
import { GetVerificationKey, expressjwt } from "express-jwt"
import { GraphQLError, GraphQLSchema } from "graphql"
import { rule } from "graphql-shield"
import jsonwebtoken from "jsonwebtoken"
import PinoHttp from "pino-http"

import { mapError } from "@graphql/error-map"

import { fieldExtensionsEstimator, simpleEstimator } from "graphql-query-complexity"

import jwksRsa from "jwks-rsa"

import {
  InsufficientApiKeyScopeError,
  apiKeyScopeForField,
  hasApiKeyScope,
  isApiKeySessionId,
} from "@domain/api-keys"
import { parseUnknownDomainErrorFromUnknown } from "@domain/shared"

import { createComplexityPlugin } from "./plugins/complexity"

import authRouter from "./authorization"
import kratosCallback from "./event-handlers/kratos"
import { apiKeyRateLimitMiddleware } from "./middlewares/api-key-rate-limit"
import healthzHandler from "./middlewares/healthz"
import { idempotencyMiddleware } from "./middlewares/idempotency"

const graphqlLogger = baseLogger.child({
  module: "graphql",
})

export const isAuthenticated = rule({ cache: "contextual" })((
  parent,
  args,
  ctx: GraphQLPublicContext & GraphQLAdminContext,
) => {
  return (
    // TODO: remove !== "anon" when auth endpoints have been removed from admin graphql
    !!("auditorId" in ctx && ctx.auditorId !== ("anon" as UserId)) || // admin API
    ("domainAccount" in ctx && !!ctx.domainAccount)
  )
})

// FIP-07 deny-by-default scope enforcement for API-key sessions (ENG-98/99).
// Kratos and anon sessions pass through untouched — isAuthenticated still gates
// anon. For API-key sessions the root field must be mapped in apiKeyScopeForField
// and the key must carry the required scope; unmapped or BLOCKED fields are denied.
export const scopedApiKeyAccess = (fieldName: string) =>
  rule({ cache: "contextual" })((parent, args, ctx: GraphQLPublicContext) => {
    if (!isApiKeySessionId(ctx.sessionId)) return true

    const required = apiKeyScopeForField[fieldName]
    if (required === undefined || required === "BLOCKED") {
      return new InsufficientApiKeyScopeError(`API keys cannot access ${fieldName}`)
    }

    return hasApiKeyScope({ grantedScopes: ctx.scopes ?? [], required })
      ? true
      : new InsufficientApiKeyScopeError(`API key missing required scope: ${required}`)
  })

// Type-level variant for nested wallet/transaction entry fields (e.g.
// ConsumerAccount.wallets, BTCWallet.balance) so a root-level grant like
// read:user cannot escalate into wallet or transaction data via `me`.
// Pass-through for non-API-key sessions; the parent field already gated auth.
export const scopedApiKeyTypeField = (required: ApiKeyScope) =>
  rule({ cache: "contextual" })((parent, args, ctx: GraphQLPublicContext) => {
    if (!isApiKeySessionId(ctx.sessionId)) return true

    return hasApiKeyScope({ grantedScopes: ctx.scopes ?? [], required })
      ? true
      : new InsufficientApiKeyScopeError(`API key missing required scope: ${required}`)
  })

const jwtAlgorithms: jsonwebtoken.Algorithm[] = ["RS256"]

export const startApolloServer = async ({
  schema,
  port,
  type,
  setGqlContext,
}: {
  schema: GraphQLSchema
  port: string | number
  type: string
  setGqlContext: (req: Request, res: Response, next: NextFunction) => Promise<void>
}): Promise<Record<string, unknown>> => {
  const app = express()
  const httpServer = createServer(app)

  const apolloPlugins = [
    createComplexityPlugin({
      schema,
      estimators: [fieldExtensionsEstimator(), simpleEstimator({ defaultComplexity: 1 })],
      maximumComplexity: 200,
      onComplete: (complexity) => {
        // TODO(telemetry): add complexity value to span
        baseLogger.debug({ complexity }, "queryComplexity")
      },
    }),
    ApolloServerPluginDrainHttpServer({ httpServer }),
  ]

  const apolloServer = new ApolloServer({
    schema,
    cache: "bounded",
    plugins: apolloPlugins,
    context: (context) => {
      return context.req.gqlContext
    },
    formatError: (err) => {
      try {
        const reportErrorToClient =
          err instanceof ApolloError || err instanceof GraphQLError

        const reportedError = {
          message: err.message,
          locations: err.locations,
          path: err.path,
          code: err.extensions?.code,
        }

        return reportErrorToClient
          ? reportedError
          : { message: `Error processing GraphQL request ${reportedError.code}` }
      } catch (err) {
        throw mapError(parseUnknownDomainErrorFromUnknown(err))
      }
    },
  })

  app.use("/auth", authRouter)
  app.use("/kratos", kratosCallback)

  // Health check
  app.get(
    "/healthz",
    healthzHandler({
      checkDbConnectionStatus: true,
      checkRedisStatus: true,
      checkLndsStatus: false,
      checkBriaStatus: false,
    }),
  )

  app.use(
    PinoHttp({
      logger: graphqlLogger,
      wrapSerializers: true,
      customProps: (req) => {
        /* eslint @typescript-eslint/ban-ts-comment: "off" */
        // @ts-ignore-next-line no-implicit-any error
        const account = req["gqlContext"]?.domainAccount
        return {
          // @ts-ignore-next-line no-implicit-any error
          "body": req["body"],
          // @ts-ignore-next-line no-implicit-any error
          "token.sub": req["token"]?.sub,
          // @ts-ignore-next-line no-implicit-any error
          "gqlContext.user": req["gqlContext"]?.user,
          // @ts-ignore-next-line no-implicit-any error
          "gqlContext.domainAccount:": {
            id: account?.id,
            createdAt: account?.createdAt,
            defaultWalletId: account?.defaultWalletId,
            level: account?.level,
            status: account?.status,
            displayCurrency: account?.displayCurrency,
          },
        }
      },
      autoLogging: {
        ignore: (req) => req.url === "/healthz",
      },
      serializers: {
        res: (res) => ({ statusCode: res.statusCode }),
        req: (req) => ({
          id: req.id,
          method: req.method,
          url: req.url,
          remoteAddress: req.remoteAddress,
          // headers: req.headers,
        }),
      },
    }),
  )

  const secret = jwksRsa.expressJwtSecret(getJwksArgs()) as GetVerificationKey // https://github.com/auth0/express-jwt/issues/288#issuecomment-1122524366

  app.use(idempotencyMiddleware) // TODO: only needed for public endpoint

  app.use(
    "/graphql",
    expressjwt({
      secret,
      algorithms: jwtAlgorithms,
      credentialsRequired: true,
      requestProperty: "token",
      issuer: "galoy.io",
    }),
  )

  app.use("/graphql", setGqlContext)

  // FIP-07 per-API-key request rate limiting (ENG-100/101) — after
  // setGqlContext so the api-key session id is known, before Apollo so
  // denials short-circuit with a real HTTP 429.
  app.use("/graphql", apiKeyRateLimitMiddleware)

  await apolloServer.start()

  apolloServer.applyMiddleware({
    app,
    path: "/graphql",
    cors: { credentials: true, origin: true },
  })

  return new Promise((resolve, reject) => {
    httpServer.listen({ port }, () => {
      console.log(
        `🚀 "${type}" server ready at http://localhost:${port}${apolloServer.graphqlPath}`,
      )

      console.log(
        `in dev mode, ${type} server should be accessed through oathkeeper reverse proxy at ${
          type === "admin"
            ? "http://localhost:4002/admin/graphql"
            : "http://localhost:4002/graphql"
        }`,
      )

      resolve({ app, httpServer, apolloServer })
    })

    httpServer.on("error", (err) => {
      console.error(err)
      reject(err)
    })
  })
}
