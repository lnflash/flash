import { RateLimiterRedis, RateLimiterRes } from "rate-limiter-flexible";
import { redis } from "@services/redis/connection";
import { baseLogger } from "@services/logger";
import { promClient } from "@services/prometheus";

const logger = baseLogger.child({ module: "adaptive-rate-limiter" });

// Different tiers of rate limiting (from existing implementation)
export const RATE_LIMIT_TIERS = {
  DEFAULT: {
    points: 100,    // 100 requests
    duration: 60,   // per minute
  },
  PREMIUM: {
    points: 600,    // 600 requests
    duration: 60,   // per minute
  },
  ENTERPRISE: {
    points: 3000,   // 3000 requests
    duration: 60,   // per minute
  },
  UNLIMITED: {
    points: 10000,  // Very high limit
    duration: 60,   // per minute
  },
};

// Adaptive rate limiting configuration
export interface AdaptiveRateLimitConfig {
  // Minimum and maximum adjustment percentages
  minAdjustmentFactor: number; // e.g., 0.8 means reduce by 20% max
  maxAdjustmentFactor: number; // e.g., 1.5 means increase by 50% max
  
  // Thresholds for triggering adaptations
  burstThresholdPercentage: number; // e.g., 0.5 means 50% of limit within burstWindowMs
  sustainedUsageThresholdPercentage: number; // e.g., 0.8 means 80% of limit consistently
  
  // Time windows for analysis
  burstWindowMs: number; // e.g., 5000 for 5 seconds
  historyWindowMs: number; // e.g., 3600000 for 1 hour
  
  // Recovery settings
  recoveryFactorPerWindow: number; // e.g., 0.1 means recover 10% per window
  throttleDurationMs: number; // e.g., 300000 for 5 minutes
  
  // Background processing interval
  analysisIntervalMs: number; // e.g., 60000 for 1 minute
}

// Default configuration
export const DEFAULT_ADAPTIVE_CONFIG: AdaptiveRateLimitConfig = {
  minAdjustmentFactor: 0.5,
  maxAdjustmentFactor: 2.0,
  burstThresholdPercentage: 0.5,
  sustainedUsageThresholdPercentage: 0.8,
  burstWindowMs: 5000,
  historyWindowMs: 3600000,
  recoveryFactorPerWindow: 0.1,
  throttleDurationMs: 300000,
  analysisIntervalMs: 60000,
};

// Result of adaptive rate limiting
export interface AdaptiveRateLimitResult {
  limited: boolean;
  remainingPoints: number;
  nextRefreshTime: Date;
  adaptiveAction?: "throttled" | "increased" | "decreased" | null;
}

// Usage pattern data stored in Redis
interface UsagePattern {
  keyId: string;
  lastUpdated: number;
  hourlyUsage: number[];
  burstCounts: number[];
  isThrottled: boolean;
  throttleUntil?: number;
  adaptiveFactor: number;
}

/**
 * Adaptive Rate Limiter - enhances the standard rate limiter with
 * adaptive capabilities based on usage patterns
 */
export class AdaptiveRateLimiter {
  private limiters: Map<string, RateLimiterRedis> = new Map();
  private baseConfig: Record<string, { points: number; duration: number }>;
  private adaptiveConfig: AdaptiveRateLimitConfig;
  private patternCache: Map<string, UsagePattern> = new Map();
  private analyzingKeys: Set<string> = new Set();
  
  // Metrics for monitoring
  private requestCounter: any;
  private throttleCounter: any;
  private adjustmentCounter: any;
  private processingTimeHistogram: any;

  /**
   * Create a new adaptive rate limiter
   * @param baseConfig Base rate limit tiers configuration
   * @param adaptiveConfig Adaptive behavior configuration
   */
  constructor(
    baseConfig: Record<string, { points: number; duration: number }> = RATE_LIMIT_TIERS,
    adaptiveConfig: AdaptiveRateLimitConfig = DEFAULT_ADAPTIVE_CONFIG
  ) {
    this.baseConfig = baseConfig;
    this.adaptiveConfig = adaptiveConfig;
    
    // Initialize base limiters for each tier
    Object.entries(baseConfig).forEach(([tier, config]) => {
      this.limiters.set(tier, new RateLimiterRedis({
        storeClient: redis,
        keyPrefix: `adaptive_rate_limit_${tier.toLowerCase()}`,
        points: config.points,
        duration: config.duration,
      }));
    });
    
    // Initialize metrics
    this.initializeMetrics();
    
    // Start background analysis process
    this.startBackgroundAnalysis();
  }

  /**
   * Consume points from the rate limiter with adaptive behavior
   * @param keyId API key ID
   * @param tier Rate limit tier
   * @param operation Operation being performed (for logging)
   * @param points Number of points to consume (default: 1)
   * @returns Adaptive rate limit result
   */
  async consume(
    keyId: string,
    tier: string = "DEFAULT",
    operation: string = "api_call",
    points: number = 1
  ): Promise<AdaptiveRateLimitResult> {
    const startTime = process.hrtime();
    
    // Increment request counter
    this.requestCounter.inc({ keyId, tier, operation });
    
    // Get base limiter for tier
    const limiter = this.limiters.get(tier) || this.limiters.get("DEFAULT")!;
    
    try {
      // Get usage pattern data
      const pattern = await this.getUsagePattern(keyId, tier);
      
      // Check if currently throttled
      if (pattern.isThrottled && pattern.throttleUntil && pattern.throttleUntil > Date.now()) {
        this.throttleCounter.inc({ keyId, tier, reason: "active_throttle" });
        
        const msBeforeNext = pattern.throttleUntil - Date.now();
        return {
          limited: true,
          remainingPoints: 0,
          nextRefreshTime: new Date(pattern.throttleUntil),
          adaptiveAction: "throttled"
        };
      }
      
      // Get effective points based on adaptive factor
      const effectivePoints = Math.max(1, Math.round(points * (1 / pattern.adaptiveFactor)));
      
      // Record current usage for pattern analysis (in background)
      this.recordUsage(keyId, tier, operation, effectivePoints).catch(error => {
        logger.error({
          message: "Failed to record usage for pattern analysis",
          keyId,
          error,
        });
      });
      
      // Attempt to consume points
      const rateLimitResult = await limiter.consume(`${keyId}:${tier}`, effectivePoints);
      
      // Record processing time
      const hrtime = process.hrtime(startTime);
      const processingTimeMs = hrtime[0] * 1000 + hrtime[1] / 1000000;
      this.processingTimeHistogram.observe(processingTimeMs);
      
      return {
        limited: false,
        remainingPoints: rateLimitResult.remainingPoints,
        nextRefreshTime: new Date(Date.now() + rateLimitResult.msBeforeNext),
        adaptiveAction: null
      };
    } catch (rateLimitError: any) {
      // Check if this burst should trigger throttling
      this.checkForThrottling(keyId, tier, operation).catch(error => {
        logger.error({
          message: "Failed to check for throttling",
          keyId,
          error,
        });
      });
      
      this.throttleCounter.inc({ keyId, tier, reason: "rate_limit_exceeded" });
      
      // Record processing time even for failures
      const hrtime = process.hrtime(startTime);
      const processingTimeMs = hrtime[0] * 1000 + hrtime[1] / 1000000;
      this.processingTimeHistogram.observe(processingTimeMs);
      
      return {
        limited: true,
        remainingPoints: 0,
        nextRefreshTime: new Date(Date.now() + (rateLimitError.msBeforeNext || 60000)),
        adaptiveAction: null
      };
    }
  }

  /**
   * Get the current adaptive factor for a key
   * @param keyId API key ID
   * @param tier Rate limit tier
   * @returns The current adaptive factor (1.0 is baseline)
   */
  async getAdaptiveFactor(keyId: string, tier: string = "DEFAULT"): Promise<number> {
    const pattern = await this.getUsagePattern(keyId, tier);
    return pattern.adaptiveFactor;
  }

  /**
   * Explicitly throttle a key for suspicious activity
   * @param keyId API key ID
   * @param tier Rate limit tier
   * @param durationMs How long to throttle in milliseconds (defaults to configured throttle duration)
   * @param reason Reason for throttling (for logging)
   */
  async throttleKey(
    keyId: string,
    tier: string = "DEFAULT",
    durationMs: number = this.adaptiveConfig.throttleDurationMs,
    reason: string = "manual"
  ): Promise<void> {
    try {
      const pattern = await this.getUsagePattern(keyId, tier);
      
      pattern.isThrottled = true;
      pattern.throttleUntil = Date.now() + durationMs;
      
      await this.saveUsagePattern(keyId, tier, pattern);
      
      this.throttleCounter.inc({ keyId, tier, reason });
      
      logger.warn({
        message: "API key explicitly throttled",
        keyId,
        tier,
        reason,
        throttleUntil: new Date(pattern.throttleUntil),
      });
    } catch (error) {
      logger.error({
        message: "Failed to throttle key",
        keyId,
        tier,
        error,
      });
      throw error;
    }
  }

  /**
   * Remove throttling from a key
   * @param keyId API key ID
   * @param tier Rate limit tier
   */
  async unthrottleKey(keyId: string, tier: string = "DEFAULT"): Promise<void> {
    try {
      const pattern = await this.getUsagePattern(keyId, tier);
      
      if (pattern.isThrottled) {
        pattern.isThrottled = false;
        delete pattern.throttleUntil;
        
        await this.saveUsagePattern(keyId, tier, pattern);
        
        logger.info({
          message: "API key throttling removed",
          keyId,
          tier,
        });
      }
    } catch (error) {
      logger.error({
        message: "Failed to unthrottle key",
        keyId,
        tier,
        error,
      });
      throw error;
    }
  }

  /**
   * Reset adaptive factor to baseline (1.0)
   * @param keyId API key ID
   * @param tier Rate limit tier
   */
  async resetAdaptiveFactor(keyId: string, tier: string = "DEFAULT"): Promise<void> {
    try {
      const pattern = await this.getUsagePattern(keyId, tier);
      
      pattern.adaptiveFactor = 1.0;
      
      await this.saveUsagePattern(keyId, tier, pattern);
      
      logger.info({
        message: "API key adaptive factor reset to baseline",
        keyId,
        tier,
      });
    } catch (error) {
      logger.error({
        message: "Failed to reset adaptive factor",
        keyId,
        tier,
        error,
      });
      throw error;
    }
  }

  /**
   * Record current usage for pattern analysis
   * @param keyId API key ID
   * @param tier Rate limit tier
   * @param operation Operation being performed
   * @param points Points consumed
   */
  private async recordUsage(
    keyId: string,
    tier: string,
    operation: string,
    points: number
  ): Promise<void> {
    try {
      const pattern = await this.getUsagePattern(keyId, tier);
      
      // Update last used timestamp
      pattern.lastUpdated = Date.now();
      
      // Update hourly usage (one entry per hour for the last 24 hours)
      const hourIndex = Math.floor(Date.now() / 3600000) % 24;
      
      // Ensure hourlyUsage array is initialized with 24 entries
      if (!pattern.hourlyUsage || pattern.hourlyUsage.length !== 24) {
        pattern.hourlyUsage = new Array(24).fill(0);
      }
      
      // Update the current hour's usage
      pattern.hourlyUsage[hourIndex] += points;
      
      // Update burst counts (one entry per burstWindow)
      const burstIndex = Math.floor(Date.now() / this.adaptiveConfig.burstWindowMs) % 12;
      
      // Ensure burstCounts array is initialized with 12 entries
      if (!pattern.burstCounts || pattern.burstCounts.length !== 12) {
        pattern.burstCounts = new Array(12).fill(0);
      }
      
      // Update the current burst window's count
      pattern.burstCounts[burstIndex] += points;
      
      // Save pattern back to Redis (but don't wait for it to complete)
      this.saveUsagePattern(keyId, tier, pattern).catch(error => {
        logger.error({
          message: "Failed to save usage pattern",
          keyId,
          tier,
          error,
        });
      });
    } catch (error) {
      logger.error({
        message: "Failed to record usage",
        keyId,
        tier,
        error,
      });
      throw error;
    }
  }

  /**
   * Check if current usage pattern should trigger throttling
   * @param keyId API key ID
   * @param tier Rate limit tier
   * @param operation Operation being performed
   */
  private async checkForThrottling(
    keyId: string,
    tier: string,
    operation: string
  ): Promise<void> {
    const pattern = await this.getUsagePattern(keyId, tier);
    const config = this.baseConfig[tier] || this.baseConfig.DEFAULT;
    
    // Get the sum of the last 3 burst windows
    const burstIndex = Math.floor(Date.now() / this.adaptiveConfig.burstWindowMs) % 12;
    const recentBurstTotal = [
      pattern.burstCounts[burstIndex],
      pattern.burstCounts[(burstIndex + 11) % 12],
      pattern.burstCounts[(burstIndex + 10) % 12]
    ].reduce((sum, count) => sum + (count || 0), 0);
    
    // Calculate burst threshold based on expected usage in 3 windows
    const burstThreshold = config.points * 
      (this.adaptiveConfig.burstWindowMs * 3) / 
      (config.duration * 1000) * 
      this.adaptiveConfig.burstThresholdPercentage;
    
    // If burst threshold exceeded, apply throttling
    if (recentBurstTotal > burstThreshold) {
      pattern.isThrottled = true;
      pattern.throttleUntil = Date.now() + this.adaptiveConfig.throttleDurationMs;
      
      // Apply more aggressive throttling by also decreasing the adaptive factor
      pattern.adaptiveFactor = Math.max(
        this.adaptiveConfig.minAdjustmentFactor,
        pattern.adaptiveFactor * 0.8 // Reduce by 20%
      );
      
      await this.saveUsagePattern(keyId, tier, pattern);
      
      this.adjustmentCounter.inc({ 
        keyId, 
        tier, 
        direction: "decrease", 
        reason: "burst_threshold_exceeded" 
      });
      
      this.throttleCounter.inc({ keyId, tier, reason: "burst_threshold_exceeded" });
      
      logger.warn({
        message: "API key throttled due to burst threshold exceeded",
        keyId,
        tier,
        burstTotal: recentBurstTotal,
        burstThreshold,
        throttleUntil: new Date(pattern.throttleUntil),
        newAdaptiveFactor: pattern.adaptiveFactor,
      });
    }
  }

  /**
   * Start background analysis of usage patterns
   */
  private startBackgroundAnalysis(): void {
    setInterval(() => {
      this.analyzePatterns().catch(error => {
        logger.error({
          message: "Error in background pattern analysis",
          error,
        });
      });
    }, this.adaptiveConfig.analysisIntervalMs);
    
    logger.info({
      message: "Started background analysis of API key usage patterns",
      analysisIntervalMs: this.adaptiveConfig.analysisIntervalMs,
    });
  }

  /**
   * Analyze usage patterns for all keys
   */
  private async analyzePatterns(): Promise<void> {
    try {
      // Get all pattern keys from Redis
      const patternKeys = await redis.keys("api_key_pattern:*");
      
      // Process each key
      for (const patternKey of patternKeys) {
        const [, keyId, tier] = patternKey.split(":");
        
        // Skip if already analyzing this key
        if (this.analyzingKeys.has(`${keyId}:${tier}`)) {
          continue;
        }
        
        // Mark as analyzing
        this.analyzingKeys.add(`${keyId}:${tier}`);
        
        // Analyze in the background
        this.analyzePattern(keyId, tier)
          .catch(error => {
            logger.error({
              message: "Error analyzing pattern",
              keyId,
              tier,
              error,
            });
          })
          .finally(() => {
            // Remove from analyzing set when done
            this.analyzingKeys.delete(`${keyId}:${tier}`);
          });
      }
    } catch (error) {
      logger.error({
        message: "Failed to fetch pattern keys for analysis",
        error,
      });
    }
  }

  /**
   * Analyze usage pattern for a specific key
   * @param keyId API key ID
   * @param tier Rate limit tier
   */
  private async analyzePattern(keyId: string, tier: string): Promise<void> {
    try {
      const pattern = await this.getUsagePattern(keyId, tier);
      const config = this.baseConfig[tier] || this.baseConfig.DEFAULT;
      
      // Skip keys that haven't been used recently (more than 24 hours)
      if (Date.now() - pattern.lastUpdated > 86400000) {
        return;
      }
      
      // If currently throttled, check if throttle period has expired
      if (pattern.isThrottled && pattern.throttleUntil && pattern.throttleUntil < Date.now()) {
        pattern.isThrottled = false;
        delete pattern.throttleUntil;
        
        logger.info({
          message: "API key throttling expired",
          keyId,
          tier,
        });
      }
      
      // Calculate average hourly usage over the last 24 hours
      const totalHourlyUsage = pattern.hourlyUsage.reduce((sum, count) => sum + (count || 0), 0);
      const avgHourlyUsage = totalHourlyUsage / 24;
      
      // Calculate expected usage per hour based on tier limits
      const expectedHourlyUsage = config.points * (3600 / config.duration);
      
      // Calculate usage ratio (actual / expected)
      const usageRatio = avgHourlyUsage / expectedHourlyUsage;
      
      // Check if usage is consistently near limit (suggesting need for higher limit)
      if (usageRatio > this.adaptiveConfig.sustainedUsageThresholdPercentage && 
          !pattern.isThrottled &&
          pattern.adaptiveFactor < this.adaptiveConfig.maxAdjustmentFactor) {
        
        // Gradually increase adaptive factor
        const newFactor = Math.min(
          this.adaptiveConfig.maxAdjustmentFactor,
          pattern.adaptiveFactor * 1.1 // Increase by 10%
        );
        
        if (newFactor !== pattern.adaptiveFactor) {
          pattern.adaptiveFactor = newFactor;
          
          this.adjustmentCounter.inc({ 
            keyId, 
            tier, 
            direction: "increase", 
            reason: "sustained_high_usage" 
          });
          
          logger.info({
            message: "API key adaptive factor increased due to sustained high usage",
            keyId,
            tier,
            usageRatio,
            oldFactor: pattern.adaptiveFactor / 1.1,
            newFactor: pattern.adaptiveFactor,
          });
        }
      }
      // Check if usage is very low (suggesting overly generous limit)
      else if (usageRatio < 0.2 && 
               !pattern.isThrottled &&
               pattern.adaptiveFactor > this.adaptiveConfig.minAdjustmentFactor) {
        
        // Gradually decrease adaptive factor for very low usage
        const newFactor = Math.max(
          this.adaptiveConfig.minAdjustmentFactor,
          pattern.adaptiveFactor * 0.95 // Decrease by 5%
        );
        
        if (newFactor !== pattern.adaptiveFactor) {
          pattern.adaptiveFactor = newFactor;
          
          this.adjustmentCounter.inc({ 
            keyId, 
            tier, 
            direction: "decrease", 
            reason: "sustained_low_usage" 
          });
          
          logger.info({
            message: "API key adaptive factor decreased due to sustained low usage",
            keyId,
            tier,
            usageRatio,
            oldFactor: pattern.adaptiveFactor / 0.95,
            newFactor: pattern.adaptiveFactor,
          });
        }
      }
      // Check if throttled key should start recovery
      else if (pattern.isThrottled === false && 
               pattern.adaptiveFactor < 1.0) {
        
        // Gradually recover adaptive factor towards baseline
        const newFactor = Math.min(
          1.0,
          pattern.adaptiveFactor * (1 + this.adaptiveConfig.recoveryFactorPerWindow)
        );
        
        if (newFactor !== pattern.adaptiveFactor) {
          pattern.adaptiveFactor = newFactor;
          
          this.adjustmentCounter.inc({ 
            keyId, 
            tier, 
            direction: "increase", 
            reason: "recovery" 
          });
          
          logger.info({
            message: "API key adaptive factor recovering towards baseline",
            keyId,
            tier,
            oldFactor: pattern.adaptiveFactor / (1 + this.adaptiveConfig.recoveryFactorPerWindow),
            newFactor: pattern.adaptiveFactor,
          });
        }
      }
      
      // Check for unusual hourly patterns (e.g., unexpected activity during off-hours)
      // This would require historical baseline data which we'll skip for now
      
      // Save updated pattern
      await this.saveUsagePattern(keyId, tier, pattern);
    } catch (error) {
      logger.error({
        message: "Failed to analyze pattern",
        keyId,
        tier,
        error,
      });
      throw error;
    }
  }

  /**
   * Get usage pattern from Redis or cache
   * @param keyId API key ID
   * @param tier Rate limit tier
   */
  private async getUsagePattern(keyId: string, tier: string): Promise<UsagePattern> {
    const cacheKey = `${keyId}:${tier}`;
    
    // Check in-memory cache first
    if (this.patternCache.has(cacheKey)) {
      return this.patternCache.get(cacheKey)!;
    }
    
    // Try to get from Redis
    const redisKey = `api_key_pattern:${keyId}:${tier}`;
    const patternJson = await redis.get(redisKey);
    
    if (patternJson) {
      try {
        const pattern = JSON.parse(patternJson) as UsagePattern;
        
        // Cache for future use
        this.patternCache.set(cacheKey, pattern);
        
        return pattern;
      } catch (error) {
        logger.error({
          message: "Failed to parse usage pattern from Redis",
          keyId,
          tier,
          error,
        });
      }
    }
    
    // Initialize new pattern if not found
    const newPattern: UsagePattern = {
      keyId,
      lastUpdated: Date.now(),
      hourlyUsage: new Array(24).fill(0),
      burstCounts: new Array(12).fill(0),
      isThrottled: false,
      adaptiveFactor: 1.0, // Start at baseline
    };
    
    // Save new pattern
    await this.saveUsagePattern(keyId, tier, newPattern);
    
    return newPattern;
  }

  /**
   * Save usage pattern to Redis and update cache
   * @param keyId API key ID
   * @param tier Rate limit tier
   * @param pattern Usage pattern to save
   */
  private async saveUsagePattern(
    keyId: string,
    tier: string,
    pattern: UsagePattern
  ): Promise<void> {
    const cacheKey = `${keyId}:${tier}`;
    const redisKey = `api_key_pattern:${keyId}:${tier}`;
    
    // Update cache
    this.patternCache.set(cacheKey, pattern);
    
    // Save to Redis (with 30-day expiry)
    await redis.set(redisKey, JSON.stringify(pattern), "EX", 2592000);
  }

  /**
   * Initialize Prometheus metrics
   */
  private initializeMetrics(): void {
    this.requestCounter = new promClient.Counter({
      name: "adaptive_rate_limiter_requests_total",
      help: "Count of API key requests",
      labelNames: ["keyId", "tier", "operation"],
    });
    
    this.throttleCounter = new promClient.Counter({
      name: "adaptive_rate_limiter_throttles_total",
      help: "Count of API key throttle events",
      labelNames: ["keyId", "tier", "reason"],
    });
    
    this.adjustmentCounter = new promClient.Counter({
      name: "adaptive_rate_limiter_adjustments_total",
      help: "Count of adaptive factor adjustments",
      labelNames: ["keyId", "tier", "direction", "reason"],
    });
    
    this.processingTimeHistogram = new promClient.Histogram({
      name: "adaptive_rate_limiter_processing_time_ms",
      help: "Processing time for rate limiting decisions",
      buckets: [0.1, 0.5, 1, 2, 5, 10, 20, 50, 100],
    });
  }
}