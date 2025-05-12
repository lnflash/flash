import { Request, Response, NextFunction } from "express";
import { AdaptiveRateLimiter } from "@services/rate-limit/adaptive-rate-limiter";
import { baseLogger } from "@services/logger";
import { ApiKeyService } from "@services/api-keys";

const logger = baseLogger.child({ module: "adaptive-rate-limit-middleware" });

// Create singleton instance of AdaptiveRateLimiter
const adaptiveRateLimiter = new AdaptiveRateLimiter();

/**
 * Express middleware for adaptive API key rate limiting
 */
export const adaptiveRateLimitMiddleware = async (
  req: Request, 
  res: Response, 
  next: NextFunction
) => {
  // Skip if no API key in request
  if (!req.apiKey) {
    return next();
  }
  
  try {
    // Get tier from API key or default to "DEFAULT"
    const tier = "DEFAULT";
    
    // Get operation name from path (simplified for demo)
    const operation = req.path.split("/").filter(Boolean).join("_") || "api_call";
    
    // Check rate limit with adaptive behavior
    const result = await adaptiveRateLimiter.consume(
      req.apiKey.id,
      tier,
      operation
    );
    
    // Add rate limit headers
    res.setHeader("X-RateLimit-Limit", getEffectiveLimitForTier(tier, result.adaptiveAction));
    res.setHeader("X-RateLimit-Remaining", result.remainingPoints);
    res.setHeader("X-RateLimit-Reset", Math.floor(result.nextRefreshTime.getTime() / 1000));
    
    // Add adaptive specific headers
    if (result.adaptiveAction) {
      res.setHeader("X-RateLimit-Adaptive-Action", result.adaptiveAction);
    }
    
    // If limited, return 429 response
    if (result.limited) {
      // Add retry-after header
      const retryAfterSeconds = Math.ceil(
        (result.nextRefreshTime.getTime() - Date.now()) / 1000
      );
      res.setHeader("Retry-After", retryAfterSeconds);
      
      // Log the rate limit event
      logger.warn({
        message: "API key rate limited by adaptive limiter",
        keyId: req.apiKey.id,
        tier,
        ip: req.ip || req.socket.remoteAddress,
        adaptiveAction: result.adaptiveAction,
        retryAfterSeconds,
      });
      
      // Add usage log for this rate limit event
      ApiKeyService.logUsage({
        apiKeyId: req.apiKey.id,
        endpoint: operation,
        ip: req.ip || req.socket.remoteAddress || "unknown",
        success: false,
        responseTimeMs: 0,
        statusCode: 429
      }).catch(error => {
        logger.error({
          message: "Failed to log rate limit in usage logs",
          keyId: req.apiKey.id,
          error,
        });
      });
      
      // Return 429 response
      return res.status(429).json({
        error: "Too Many Requests",
        message: result.adaptiveAction === "throttled"
          ? "API key has been temporarily throttled due to suspicious activity"
          : "API rate limit exceeded",
        details: {
          tier,
          adaptiveAction: result.adaptiveAction,
          retryAfter: retryAfterSeconds,
        },
      });
    }
    
    // Continue to next middleware
    next();
  } catch (error) {
    logger.error({
      message: "Error in adaptive rate limit middleware",
      keyId: req.apiKey?.id,
      error,
    });
    
    // Continue to next middleware on error
    next();
  }
};

/**
 * Get effective rate limit for a tier based on adaptive action
 * @param tier Rate limit tier
 * @param adaptiveAction Current adaptive action
 * @returns Effective rate limit
 */
function getEffectiveLimitForTier(tier: string, adaptiveAction?: string): number {
  const baseTierLimits: Record<string, number> = {
    DEFAULT: 100,
    PREMIUM: 600,
    ENTERPRISE: 3000,
    UNLIMITED: 10000,
  };
  
  const baseLimit = baseTierLimits[tier] || baseTierLimits.DEFAULT;
  
  // Apply adaptive adjustments to displayed limit
  if (adaptiveAction === "throttled") {
    return Math.round(baseLimit * 0.5); // Show 50% of limit when throttled
  } else if (adaptiveAction === "decreased") {
    return Math.round(baseLimit * 0.8); // Show 80% of limit when decreased
  } else if (adaptiveAction === "increased") {
    return Math.round(baseLimit * 1.2); // Show 120% of limit when increased
  }
  
  return baseLimit;
}

/**
 * Get the adaptive rate limiter instance for direct usage
 * @returns AdaptiveRateLimiter instance
 */
export function getAdaptiveRateLimiter(): AdaptiveRateLimiter {
  return adaptiveRateLimiter;
}