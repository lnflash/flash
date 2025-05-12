import { ApiKeyService } from "@services/api-keys"
import { Request, Response, NextFunction } from "express"
import { ApiKeyNotFoundError, ApiKeyInvalidError, ApiKeyRevokedError, ApiKeyExpiredError, ApiKeyInactiveError, ScopeNotAllowedError } from "@domain/api-keys/errors"
import { Scope } from "@domain/api-keys"
import { AdaptiveRateLimiter } from "@services/rate-limit/adaptive-rate-limiter"
import { RateLimitExceededError } from "@domain/api-keys/errors"
import { RateLimitLevel, RATE_LIMIT_POINTS, RATE_LIMIT_DURATION } from "@services/rate-limit/adaptive-rate-limiter.types"

// Headers for API key authentication
const API_KEY_HEADER = "Authorization"
const API_KEY_QUERY_PARAM = "apiKey"
const API_KEY_HEADER_PREFIX = "ApiKey "

// Create rate limiter instance
const apiKeyRateLimiter = new AdaptiveRateLimiter()

// Middleware for authenticating API keys
export const apiKeyAuthMiddleware = (requiredScopes?: Scope[]) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    let apiKey: string | undefined

    // Extract API key from header
    const authHeader = req.header(API_KEY_HEADER)
    if (authHeader && authHeader.startsWith(API_KEY_HEADER_PREFIX)) {
      apiKey = authHeader.slice(API_KEY_HEADER_PREFIX.length)
    }

    // Extract API key from query parameter (fallback, less secure)
    if (!apiKey && req.query[API_KEY_QUERY_PARAM]) {
      apiKey = req.query[API_KEY_QUERY_PARAM] as string
    }

    // If no API key found, continue to next middleware (might be using a different auth method)
    if (!apiKey) {
      return next()
    }

    try {
      // Verify the API key and get associated data
      const apiKeyData = await ApiKeyService.verifyKey(apiKey, requiredScopes)
      
      // Apply rate limiting
      const rateLimitResult = await apiKeyRateLimiter.consume(
        apiKeyData.id,
        apiKeyData.tier,
        req.path,
        1, // default points
      )
      
      if (rateLimitResult.limited) {
        throw new RateLimitExceededError()
      }
      
      // Set rate limit headers based on tier
      const tierLimit = RATE_LIMIT_POINTS[apiKeyData.tier as RateLimitLevel] || RATE_LIMIT_POINTS.DEFAULT
      res.setHeader("X-RateLimit-Limit", tierLimit.toString())
      res.setHeader("X-RateLimit-Remaining", rateLimitResult.remainingPoints.toString())
      res.setHeader("X-RateLimit-Reset", Math.floor(rateLimitResult.nextRefreshTime.getTime() / 1000).toString())
      res.setHeader("X-RateLimit-Used", (tierLimit - rateLimitResult.remainingPoints).toString())
      
      // Set API key context in request
      req.apiKey = {
        id: apiKeyData.id,
        accountId: apiKeyData.accountId,
        scopes: apiKeyData.scopes,
      }
      
      // Log API key usage asynchronously (don't await)
      const startTime = Date.now()
      const logUsage = async () => {
        const responseTime = Date.now() - startTime
        try {
          await ApiKeyService.logUsage({
            apiKeyId: apiKeyData.id,
            endpoint: req.path,
            ip: req.ip,
            success: res.statusCode < 400,
            responseTimeMs: responseTime,
            statusCode: res.statusCode,
          })
        } catch (error) {
          // Silently fail - logging should not block the request
          console.error(`Failed to log API key usage: ${error}`)
        }
      }
      
      // Add response listener to log after completion
      res.on("finish", logUsage)
      
      return next()
    } catch (error) {
      // Handle authentication errors
      if (error instanceof ApiKeyNotFoundError || 
          error instanceof ApiKeyInvalidError) {
        return res.status(401).json({
          error: "Invalid API key",
          code: "INVALID_API_KEY",
        })
      }
      
      if (error instanceof ApiKeyRevokedError) {
        return res.status(401).json({
          error: "API key has been revoked",
          code: "REVOKED_API_KEY",
        })
      }
      
      if (error instanceof ApiKeyExpiredError) {
        return res.status(401).json({
          error: "API key has expired",
          code: "EXPIRED_API_KEY",
        })
      }
      
      if (error instanceof ApiKeyInactiveError) {
        return res.status(401).json({
          error: "API key is inactive",
          code: "INACTIVE_API_KEY",
        })
      }
      
      if (error instanceof ScopeNotAllowedError) {
        return res.status(403).json({
          error: "Insufficient permissions",
          code: "INSUFFICIENT_PERMISSIONS",
        })
      }
      
      if (error instanceof RateLimitExceededError) {
        return res.status(429).json({
          error: "Rate limit exceeded",
          code: "RATE_LIMIT_EXCEEDED",
        })
      }
      
      // Generic error
      return res.status(500).json({
        error: "Authentication error",
        code: "AUTH_ERROR",
      })
    }
  }
}

// Extend Express Request interface to include API key data
declare global {
  namespace Express {
    interface Request {
      apiKey?: {
        id: string
        accountId: string
        scopes: Scope[]
      }
    }
  }
}