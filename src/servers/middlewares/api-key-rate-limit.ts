import { NextFunction, Request, Response } from "express"

import { getApiKeyConfig } from "@config"
import { API_KEY_SESSION_PREFIX, isApiKeySessionId } from "@domain/api-keys"
import { auditApiKeyRateLimited } from "@services/api-keys-audit"
import { incApiKeyRateLimited } from "@services/api-keys-metrics"
import { baseLogger } from "@services/logger"
import { consumeApiKeyRequestRateLimit } from "@services/rate-limit/api-keys"

// Per-API-key request rate limiting (FIP-07, ENG-100/101). Registered right
// after setGqlContext so gqlContext.sessionId is populated; kratos and anon
// sessions pass through untouched. Any internal failure fails open — rate
// limiting must never take the API down.
//
// Response shape: this /graphql server is a federation subgraph behind the
// Apollo router. The router forwards a subgraph response to the client ONLY
// when it is HTTP 200 with a GraphQL body; any non-2xx (e.g. a bare 429) is
// swallowed and re-emitted as an opaque SUBREQUEST_HTTP_ERROR. So a denial is
// returned as an HTTP 200 GraphQL error with code TOO_MANY_REQUESTS and the
// retry metadata in `extensions` (which the router forwards, matching how every
// other galoy rate limit surfaces). X-RateLimit-* / Retry-After headers are set
// best-effort — they reach clients hitting this server directly but the
// federation router does not forward subgraph response headers.
export const apiKeyRateLimitMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const gqlContext = req.gqlContext
    const sessionId =
      gqlContext && "sessionId" in gqlContext ? gqlContext.sessionId : undefined
    if (!sessionId || !isApiKeySessionId(sessionId)) {
      return next()
    }

    const keyId = sessionId.slice(API_KEY_SESSION_PREFIX.length)
    // The numeric rate_limit claim is minted by oathkeeper from the check
    // endpoint; fall back to the config default when absent or malformed.
    const limitPerMinute =
      Number(req.token?.rate_limit) || getApiKeyConfig().defaultRequestsPerMinute

    const result = await consumeApiKeyRequestRateLimit({ keyId, limitPerMinute })

    res.set("X-RateLimit-Limit", `${result.limit}`)
    res.set("X-RateLimit-Remaining", `${result.remaining}`)
    res.set("X-RateLimit-Reset", `${Math.ceil(Date.now() / 1000) + result.resetSeconds}`)

    if (!result.allowed) {
      incApiKeyRateLimited()
      auditApiKeyRateLimited({ keyId })
      res.set("Retry-After", `${result.retryAfterSeconds}`)
      // HTTP 200 + GraphQL error so the federation router forwards it intact.
      return res.status(200).json({
        data: null,
        errors: [
          {
            message: "API key rate limit exceeded",
            extensions: {
              code: "TOO_MANY_REQUESTS",
              retryAfterSeconds: result.retryAfterSeconds,
              rateLimit: { limit: result.limit, remaining: result.remaining },
            },
          },
        ],
      })
    }

    return next()
  } catch (err) {
    baseLogger.warn({ err }, "api key rate limit middleware error - failing open")
    return next()
  }
}
