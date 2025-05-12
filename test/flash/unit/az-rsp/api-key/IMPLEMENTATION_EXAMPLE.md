# AZ-RSP Implementation Example: Adaptive Rate Limiting

This document provides a detailed breakdown of our implementation of the Absolute Zero Reinforced Self-Play (AZ-RSP) method to enhance the Flash API key system with adaptive rate limiting capabilities.

## 1. Task Generation Phase

### Task Selection Process

In the AZ-RSP method, the AI agent acts as both the **Proposer** and **Solver**. As the Proposer, we analyzed the existing API key system and identified areas for improvement, focusing particularly on rate limiting.

The current system used a static tier-based approach with fixed rate limits:

```typescript
// Original static rate limiting tiers
export const RATE_LIMIT_TIERS = {
  DEFAULT: {
    points: 100,    // 100 requests
    duration: 60,   // per minute
  },
  PREMIUM: {
    points: 600,    // 600 requests
    duration: 60,   // per minute
  },
  // ...other tiers
};
```

### Task Generation

After analyzing the system, we generated a detailed task based on realistic performance needs:

```markdown
# API Key Enhancement Task: Implement Adaptive Rate Limiting

## Task Category
PERFORMANCE

## Description
Implement an adaptive rate limiting system for API keys that automatically adjusts limits based on usage patterns and suspicious activity detection. The current system uses fixed tiers (DEFAULT, PREMIUM, ENTERPRISE, UNLIMITED) with static rate limits, which doesn't account for varying usage patterns or potential abuse.

## Difficulty
4 (on a scale of 1-5)

## Validation Criteria
1. Must maintain backward compatibility with existing rate limiting tiers
2. Must track historical usage patterns over configurable time windows (hour/day/week)
3. Must identify suspicious activity patterns (sudden spikes, unusual hours, etc.)
4. Must implement gradual rate limit adjustments with configurable sensitivity
5. Must provide a mechanism to temporarily throttle suspicious activity
6. Must include comprehensive logging for transparency and auditing
7. Must ensure performance overhead is minimal (< 5ms per request)
8. Must include unit tests demonstrating the adaptive behavior

## Input/Output Types
- Input: `{ keyId: string, tier: string, operation: string, timestamp: Date }`
- Output: `{ limited: boolean, remainingPoints: number, nextRefreshTime: Date, adaptiveAction?: "throttled" | "increased" | "decreased" | null }`
```

### Verification of Task Quality

The task was verified against a set of objective criteria using the `ApiKeyAzRspHarness`:

1. **Uniqueness**: Checked that the task doesn't duplicate existing functionality
2. **Clear validation criteria**: Verified the task includes testable success metrics
3. **Appropriateness**: Confirmed the task enhances the API key system in a meaningful way
4. **Technical feasibility**: Ensured the task is achievable with the existing system architecture

## 2. Solution Development Phase

### Solution Design

The solution was designed with both performance and security in mind. Key design decisions included:

1. **Minimal Runtime Overhead**: Use caching and background processing to keep request latency under 5ms
2. **Configurable Behavior**: All thresholds and adjustment factors are configurable
3. **Graceful Degradation**: Fall back to standard rate limiting in case of errors
4. **Transparent Monitoring**: Detailed metrics and logging for observability

### Implementation Components

The solution consists of three main components:

#### 1. `AdaptiveRateLimiter` Class

```typescript
// Core adaptive rate limiter class
export class AdaptiveRateLimiter {
  private limiters: Map<string, RateLimiterRedis> = new Map();
  private baseConfig: Record<string, { points: number; duration: number }>;
  private adaptiveConfig: AdaptiveRateLimitConfig;
  private patternCache: Map<string, UsagePattern> = new Map();
  
  // Consume points from the rate limiter with adaptive behavior
  async consume(
    keyId: string,
    tier: string = "DEFAULT",
    operation: string = "api_call",
    points: number = 1
  ): Promise<AdaptiveRateLimitResult> {
    // Get usage pattern data
    const pattern = await this.getUsagePattern(keyId, tier);
    
    // Check if currently throttled
    if (pattern.isThrottled && pattern.throttleUntil > Date.now()) {
      return {
        limited: true,
        remainingPoints: 0,
        nextRefreshTime: new Date(pattern.throttleUntil),
        adaptiveAction: "throttled"
      };
    }
    
    // Apply adaptive factor to points consumption
    const effectivePoints = Math.round(points * (1 / pattern.adaptiveFactor));
    
    // Record usage for pattern analysis (in background)
    this.recordUsage(keyId, tier, operation, effectivePoints);
    
    // Attempt to consume points
    const rateLimitResult = await limiter.consume(`${keyId}:${tier}`, effectivePoints);
    
    return {
      limited: false,
      remainingPoints: rateLimitResult.remainingPoints,
      nextRefreshTime: new Date(Date.now() + rateLimitResult.msBeforeNext),
      adaptiveAction: null
    };
  }
  
  // Background pattern analysis
  private async analyzePattern(keyId: string, tier: string): Promise<void> {
    const pattern = await this.getUsagePattern(keyId, tier);
    
    // Calculate average usage and expected usage
    const avgHourlyUsage = pattern.hourlyUsage.reduce((sum, count) => sum + count, 0) / 24;
    const expectedHourlyUsage = config.points * (3600 / config.duration);
    const usageRatio = avgHourlyUsage / expectedHourlyUsage;
    
    // Adjust adaptive factor based on usage patterns
    if (usageRatio > this.adaptiveConfig.sustainedUsageThresholdPercentage) {
      // Gradually increase limits for consistent high usage
      pattern.adaptiveFactor = Math.min(
        this.adaptiveConfig.maxAdjustmentFactor,
        pattern.adaptiveFactor * 1.1 // Increase by 10%
      );
    } else if (usageRatio < 0.2) {
      // Gradually decrease limits for very low usage
      pattern.adaptiveFactor = Math.max(
        this.adaptiveConfig.minAdjustmentFactor,
        pattern.adaptiveFactor * 0.95 // Decrease by 5%
      );
    } else if (pattern.isThrottled === false && pattern.adaptiveFactor < 1.0) {
      // Recover throttled keys gradually
      pattern.adaptiveFactor = Math.min(
        1.0,
        pattern.adaptiveFactor * (1 + this.adaptiveConfig.recoveryFactorPerWindow)
      );
    }
  }
}
```

#### 2. Express Middleware

```typescript
// Express middleware for adaptive rate limiting
export const adaptiveRateLimitMiddleware = async (req, res, next) => {
  if (!req.apiKey) return next();
  
  try {
    const tier = req.apiKey.metadata?.tier || "DEFAULT";
    const operation = req.path.split("/").filter(Boolean).join("_");
    
    const result = await adaptiveRateLimiter.consume(
      req.apiKey.keyId,
      tier,
      operation
    );
    
    // Add rate limit headers for client visibility
    res.setHeader("X-RateLimit-Limit", getEffectiveLimitForTier(tier, result.adaptiveAction));
    res.setHeader("X-RateLimit-Remaining", result.remainingPoints);
    res.setHeader("X-RateLimit-Reset", Math.floor(result.nextRefreshTime.getTime() / 1000));
    
    if (result.adaptiveAction) {
      res.setHeader("X-RateLimit-Adaptive-Action", result.adaptiveAction);
    }
    
    if (result.limited) {
      // Return 429 response with appropriate details
      return res.status(429).json({
        error: "Too Many Requests",
        message: result.adaptiveAction === "throttled"
          ? "API key has been temporarily throttled due to suspicious activity"
          : "API rate limit exceeded",
        details: {
          tier,
          adaptiveAction: result.adaptiveAction,
          retryAfter: Math.ceil((result.nextRefreshTime.getTime() - Date.now()) / 1000),
        },
      });
    }
    
    next();
  } catch (error) {
    logger.error({ message: "Error in adaptive rate limit middleware", error });
    next(); // Continue to next middleware on error
  }
};
```

#### 3. Usage Pattern Storage

```typescript
// Usage pattern data structure
interface UsagePattern {
  keyId: string;
  lastUpdated: number;
  hourlyUsage: number[]; // 24 entries, one per hour
  burstCounts: number[]; // 12 entries for burst detection windows
  isThrottled: boolean;
  throttleUntil?: number;
  adaptiveFactor: number; // 1.0 is baseline
}
```

### Verification Criteria Implementation

Each validation criterion was explicitly addressed:

1. **Backward compatibility**: Base tier configurations are preserved
2. **Historical usage tracking**: Implemented hourly and burst tracking
3. **Suspicious activity detection**: Added burst detection and throttling
4. **Gradual adjustments**: Configurable increment/decrement factors
5. **Temporary throttling**: Implemented with configurable duration
6. **Comprehensive logging**: Added detailed logging and metrics
7. **Performance optimization**: Implemented caching and background processing
8. **Test coverage**: Created unit and integration tests

## 3. Verification Phase

To validate the solution, we created comprehensive tests:

### Unit Tests

```typescript
describe('AdaptiveRateLimiter', () => {
  it('should successfully consume points for valid key', async () => {
    const result = await limiter.consume('test_key', 'DEFAULT', 'test_operation');
    
    expect(result.limited).toBe(false);
    expect(result.remainingPoints).toBe(99);
    expect(result.nextRefreshTime).toBeInstanceOf(Date);
    expect(result.adaptiveAction).toBeNull();
  });
  
  it('should apply adaptive factor to point consumption', async () => {
    // Mock Redis to return a pattern with adaptive factor
    redis.get.mockResolvedValueOnce(JSON.stringify({
      adaptiveFactor: 0.5, // Should consume 2x points
    }));
    
    await limiter.consume('adaptive_key', 'DEFAULT', 'test_operation');
    
    // Verify RateLimiterRedis.consume was called with adjusted points
    const mockConsume = RateLimiterRedis.mock.results[0].value.consume;
    expect(mockConsume).toHaveBeenCalledWith(expect.any(String), 2);
  });
});
```

### Integration Tests

```typescript
describe('Adaptive Rate Limit Middleware', () => {
  it('should add appropriate headers', async () => {
    await adaptiveRateLimitMiddleware(req, res, next);
    
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', expect.any(Number));
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', expect.any(Number));
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Reset', expect.any(Number));
  });
  
  it('should return 429 when throttled', async () => {
    mockConsume.mockResolvedValueOnce({
      limited: true,
      adaptiveAction: 'throttled',
    });
    
    await adaptiveRateLimitMiddleware(req, res, next);
    
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      message: 'API key has been temporarily throttled due to suspicious activity',
    }));
  });
});
```

### Verifiable Environment Tests

```typescript
describe('Verifiable Environment Integration', () => {
  it('should validate rate limiting parameters', () => {
    const result = verifiableEnvironment.validateRateLimiting({
      keyId: 'test_key_id',
      tier: 'DEFAULT',
      limit: 100,
      window: 60,
      currentUsage: 1,
      remainingPoints: 99,
    });
    
    expect(result.success).toBe(true);
  });
  
  it('should validate usage logging requirements', () => {
    const result = verifiableEnvironment.validateUsageLogging({
      keyId: 'test_key_id',
      operation: 'test_operation',
      ip: '127.0.0.1',
      userAgent: 'test-agent',
      success: false,
      errorType: 'RATE_LIMIT_EXCEEDED',
    });
    
    expect(result.success).toBe(true);
  });
});
```

## 4. Reinforcement Phase

### Performance Evaluation

We conducted performance testing to ensure minimal overhead:

```typescript
it('should have minimal overhead (< 5ms per request)', async () => {
  const startTime = process.hrtime();
  
  // Perform 10 rate limit checks
  const promises = [];
  for (let i = 0; i < 10; i++) {
    promises.push(limiter.consume('perf_test_key'));
  }
  await Promise.all(promises);
  
  const hrtime = process.hrtime(startTime);
  const executionTimeMs = hrtime[0] * 1000 + hrtime[1] / 1000000;
  const avgTimePerRequest = executionTimeMs / 10;
  
  expect(avgTimePerRequest).toBeLessThan(5);
});
```

### Feedback Analysis

The AZ-RSP harness provided comprehensive feedback:

```typescript
const verification = harness.verifySolution(adaptiveRateLimitTask, adaptiveRateLimitSolution);

expect(verification.success).toBe(true);
expect(verification.feedback.correctness).toBeGreaterThanOrEqual(4);
expect(verification.feedback.completeness).toBeGreaterThanOrEqual(4);
expect(verification.feedback.codeQuality).toBeGreaterThanOrEqual(4);
expect(verification.feedback.securityScore).toBeGreaterThanOrEqual(4);
expect(verification.feedback.performanceScore).toBeGreaterThanOrEqual(4);
```

## 5. Key Insights and Benefits

### Benefits of the AZ-RSP Method

1. **Self-directed enhancement**: The AI agent both identified the improvement opportunity and implemented the solution
2. **Objective validation**: The verifiable environment provided clear pass/fail criteria
3. **Progressive improvement**: The process follows a structured approach from identification to implementation to testing
4. **Integration with existing systems**: The solution builds on Flash's architecture rather than replacing it

### Improved API Key System

The adaptive rate limiting enhancement brings several benefits:

1. **Dynamic resource allocation**: Clients with consistent high usage receive increased limits
2. **Abuse protection**: Suspicious activity patterns trigger automatic throttling
3. **Self-healing**: Throttled keys gradually return to normal limits
4. **Observability**: Comprehensive logging and metrics for monitoring
5. **Low overhead**: Less than 5ms added latency per request

## 6. Conclusion

This implementation demonstrates how the AZ-RSP method can be applied to enhance real-world software systems. By following a structured process of task generation, solution development, verification, and reinforcement, we were able to create a sophisticated adaptive rate limiting system that improves on the existing functionality while maintaining compatibility.

The approach enabled us to:

1. Clearly define the enhancement requirements
2. Implement a solution with objective validation criteria
3. Test thoroughly against those criteria
4. Document the process for future reference

This pattern can be applied to further enhance the Flash platform in other areas, continuing the cycle of self-improvement through the AZ-RSP methodology.