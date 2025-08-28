import { applyMiddleware } from "graphql-middleware"
import { and, rule, shield } from "graphql-shield"
import { Rule, RuleAnd } from "graphql-shield/typings/rules"
import { baseLogger } from "@services/logger"
import { setupMongoConnection } from "@services/mongodb"
import { adminMutationFields, adminQueryFields, gqlAdminSchema } from "@graphql/admin"
import { ADMIN_CONFIG } from "@config"
import { AuthenticationError, AuthorizationError } from "@graphql/error"

import { createServer } from "http"
import express from "express"
import { ApolloServerPluginDrainHttpServer } from "apollo-server-core"
import { ApolloError, ApolloServer, ExpressContext } from "apollo-server-express"
import { GraphQLError, GraphQLSchema } from "graphql"
import PinoHttp from "pino-http"
import { mapError } from "@graphql/error-map"
import { fieldExtensionsEstimator, simpleEstimator } from "graphql-query-complexity"
import { createComplexityPlugin } from "graphql-query-complexity-apollo-plugin"
import { parseUnknownDomainErrorFromUnknown } from "@domain/shared"
import healthzHandler from "./middlewares/healthz"
import { idempotencyMiddleware } from "./middlewares/idempotency"
import requestIp from "request-ip"
import jwt from 'jsonwebtoken'

const graphqlLogger = baseLogger.child({ module: "graphql" })

interface JWTPayload {
  userId: string;
  roles: string[];
}

// Parse the "Authorization" header to verify the JWT token and return its payload
function parseAuthHeader(authHeader: string | undefined): JWTPayload {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new AuthenticationError({ message: 'Invalid authorization header', logger: graphqlLogger });
  }
  try {
    const token = authHeader.slice(7);
    console.info('ERPNEXT_JWT_SECRET:', ADMIN_CONFIG.ERPNEXT_JWT_SECRET);
    return jwt.verify(token, ADMIN_CONFIG.ERPNEXT_JWT_SECRET as string) as JWTPayload; // process.env.ERPNEXT_JWT_SECRET
  } catch (error) {
    throw new AuthenticationError({ message: 'Invalid Token', logger: graphqlLogger });
  }
}

export const hasAdminUserRole = rule({ cache: "contextual" })((
  parent,
  args,
  ctx: GraphQLAdminContext,
) => {
  return ctx.user.roles.includes("Flash Admin") ? true : new AuthorizationError({ logger: graphqlLogger })
})


//   // const ipString = UNSECURE_IP_FROM_REQUEST_OBJECT
//   //   ? req.ip
//   //   : req.headers["x-real-ip"] || req.headers["x-forwarded-for"]

//   // const ip = parseIps(ipString)
//   // if (!ip) {
//   //   graphqlLogger.error("ip missing")
//   //   return
//   // }
//   addAttributesToCurrentSpanAndPropagate(
//     {
      // [SemanticAttributes.HTTP_CLIENT_IP]: ip,
//       [SemanticAttributes.HTTP_USER_AGENT]: req.headers["user-agent"],
//     },
//     next,
//   )
// }

const startAdminServer = async ({
  schema,
  port,
  type,
}: {
  schema: GraphQLSchema
  port: string | number
  type: string
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
    context: (ctx: ExpressContext) => {
      const { authorization } = ctx.req.headers;
      const decodedJwt = parseAuthHeader(authorization);
      return {
        logger: graphqlLogger, 
        user: {
          id: decodedJwt.userId,
          roles: decodedJwt.roles,
          ip: requestIp.getClientIp(ctx.req),
        }
      }
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

  app.use(idempotencyMiddleware) // TODO: only needed for public endpoint

  await apolloServer.start()

  apolloServer.applyMiddleware({
    app,
    path: "/graphql",
    cors: { credentials: true, origin: true }, // change to erpnext
  })

  return new Promise((resolve, reject) => {
    httpServer.listen({ port }, () => {
      console.log(
        `🚀 "${type}" server ready at http://localhost:${port}${apolloServer.graphqlPath}`,
      )

      console.log(
        `in dev mode, ${type} server should be accessed through oathkeeper reverse proxy at ${
          "http://localhost:4002/admin/graphql"
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

export async function startApolloServerForAdminSchema() {
  const authedQueryFields: { [key: string]: Rule } = {}
  for (const key of Object.keys(adminQueryFields.authed)) {
    authedQueryFields[key] = hasAdminUserRole
  }

  const authedMutationFields: { [key: string]: Rule } = {}
  for (const key of Object.keys(adminMutationFields.authed)) {
    authedMutationFields[key] = hasAdminUserRole
  }

  const permissions = shield(
    {
      Query: authedQueryFields,
      Mutation: authedMutationFields,
    },
    {
      allowExternalErrors: true,
      fallbackError: new AuthorizationError({ logger: baseLogger }),
    },
  )

  const schema = applyMiddleware(gqlAdminSchema, permissions)
  return startAdminServer({
    schema,
    port: ADMIN_CONFIG.GALOY_ADMIN_PORT,
    type: "admin",
  })
}

if (require.main === module) {
  setupMongoConnection()
    .then(async () => {
      await startApolloServerForAdminSchema()
    })
    .catch((err) => graphqlLogger.error(err, "server error"))
}