import { NextFunction, Request, Response } from "express"

import { getApiKeyConfig } from "@config"
import { API_KEY_SESSION_PREFIX, isApiKeySessionId } from "@domain/api-keys"
import { auditApiKeyRateLimited } from "@services/api-keys-audit"
import { incApiKeyRateLimited } from "@services/api-keys-metrics"
import { baseLogger } from "@services/logger"
import { consumeApiKeyRequestRateLimit } from "@services/rate-limit/api-keys"

// Per-API-key request rate limiting (FIP-07, ENG-100/101). Registered right
// after setGqlContext so gqlContext.sessionId is populated; kratos and anon
// sessions pass through untouched. Denials short-circuit with a real HTTP 429
// plus standard X-RateLimit-* / Retry-After headers before the request ever
// reaches Apollo. Any internal failure fails open — rate limiting must never
// take the API down.
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
      return res.status(429).json({
        error: { code: "TOO_MANY_REQUESTS", message: "API key rate limit exceeded" },
      })
    }

    return next()
  } catch (err) {
    baseLogger.warn({ err }, "api key rate limit middleware error - failing open")
    return next()
  }
}
