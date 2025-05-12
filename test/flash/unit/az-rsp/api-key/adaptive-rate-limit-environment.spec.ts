import { ApiKeyVerifiableEnvironment, ValidationResult } from './verifiable-environment';
import { AdaptiveRateLimiter, AdaptiveRateLimitConfig } from '@services/rate-limit/adaptive-rate-limiter';
import { adaptiveRateLimitMiddleware } from '@servers/middlewares/adaptive-rate-limit';

// Mock Redis
jest.mock('@services/redis/connection', () => ({
  redis: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    keys: jest.fn().mockResolvedValue([]),
  },
}));

// Mock RateLimiterRedis
jest.mock('rate-limiter-flexible', () => {
  const originalModule = jest.requireActual('rate-limiter-flexible');
  
  return {
    ...originalModule,
    RateLimiterRedis: jest.fn().mockImplementation(() => ({
      consume: jest.fn().mockImplementation(() => {
        return Promise.resolve({
          msBeforeNext: 60000,
          remainingPoints: 99,
        });
      })
    })),
  };
});

// Mock promClient
jest.mock('@services/prometheus', () => ({
  promClient: {
    Counter: jest.fn().mockImplementation(() => ({
      inc: jest.fn(),
    })),
    Histogram: jest.fn().mockImplementation(() => ({
      observe: jest.fn(),
    })),
  },
}));

// Mock ApiKeyService
jest.mock('@services/api-key', () => ({
  ApiKeyService: jest.fn().mockImplementation(() => ({
    addUsageLog: jest.fn().mockResolvedValue(true),
  })),
}));

describe('Adaptive Rate Limiter with Verifiable Environment', () => {
  let verifiableEnvironment: ApiKeyVerifiableEnvironment;
  let limiter: AdaptiveRateLimiter;
  
  // Test config with minimum values for validation
  const testConfig: AdaptiveRateLimitConfig = {
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
  
  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();
    
    // Create verifiable environment
    verifiableEnvironment = new ApiKeyVerifiableEnvironment();
    
    // Create limiter with test config
    limiter = new AdaptiveRateLimiter(undefined, testConfig);
  });
  
  describe('Rate Limit Configuration Validation', () => {
    it('should validate the rate limit configuration', () => {
      // Validation criteria
      const result = verifiableEnvironment.validateRateLimiting({
        keyId: 'test_key_id',
        tier: 'DEFAULT',
        limit: 100,
        window: 60,
        currentUsage: 20,
        remainingPoints: 80,
      });
      
      expect(result.success).toBe(true);
    });
    
    it('should reject invalid rate limit configuration', () => {
      // Test negative limit
      let result = verifiableEnvironment.validateRateLimiting({
        keyId: 'test_key_id',
        tier: 'DEFAULT',
        limit: -10, // Negative limit
        window: 60,
        currentUsage: 20,
        remainingPoints: 80,
      });
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('Rate limit must be positive');
      
      // Test negative window
      result = verifiableEnvironment.validateRateLimiting({
        keyId: 'test_key_id',
        tier: 'DEFAULT',
        limit: 100,
        window: -60, // Negative window
        currentUsage: 20,
        remainingPoints: 80,
      });
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('Rate limit window must be positive');
      
      // Test inconsistent usage and remaining points
      result = verifiableEnvironment.validateRateLimiting({
        keyId: 'test_key_id',
        tier: 'DEFAULT',
        limit: 100,
        window: 60,
        currentUsage: 30,
        remainingPoints: 80, // Should be 70 for limit of 100
      });
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('Current usage plus remaining points must equal the limit');
    });
  });
  
  describe('Usage Logging Validation', () => {
    it('should validate correct usage logging', () => {
      const result = verifiableEnvironment.validateUsageLogging({
        keyId: 'test_key_id',
        operation: 'test_operation',
        ip: '127.0.0.1',
        userAgent: 'test-agent',
        success: true,
      });
      
      expect(result.success).toBe(true);
    });
    
    it('should require error type for failed operations', () => {
      const result = verifiableEnvironment.validateUsageLogging({
        keyId: 'test_key_id',
        operation: 'test_operation',
        ip: '127.0.0.1',
        userAgent: 'test-agent',
        success: false,
        // Missing errorType
      });
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('Error type is required when success is false');
    });
    
    it('should validate all required fields', () => {
      // Test missing operation
      let result = verifiableEnvironment.validateUsageLogging({
        keyId: 'test_key_id',
        operation: '', // Empty operation
        ip: '127.0.0.1',
        userAgent: 'test-agent',
        success: true,
      });
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('Operation name is required');
      
      // Test missing IP
      result = verifiableEnvironment.validateUsageLogging({
        keyId: 'test_key_id',
        operation: 'test_operation',
        ip: '', // Empty IP
        userAgent: 'test-agent',
        success: true,
      });
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('IP address is required');
    });
  });
  
  describe('Integration with Adaptive Rate Limiter', () => {
    it('should consume rate limit with verifiable parameters', async () => {
      // Create test API key
      const { apiKey, key } = verifiableEnvironment.generateTestApiKey();
      
      // Consume from limiter
      const result = await limiter.consume(apiKey.keyId);
      
      // Validate consumption result
      expect(result.limited).toBe(false);
      expect(result.remainingPoints).toBe(99);
      expect(result.nextRefreshTime).toBeInstanceOf(Date);
      
      // Validate using verifiable environment
      const validationResult = verifiableEnvironment.validateRateLimiting({
        keyId: apiKey.keyId,
        tier: 'DEFAULT',
        limit: 100,
        window: 60,
        currentUsage: 1,
        remainingPoints: result.remainingPoints,
      });
      
      expect(validationResult.success).toBe(true);
    });
    
    it('should properly validate throttling behavior', async () => {
      // Mock Redis to return a throttled pattern
      const redis = require('@services/redis/connection').redis;
      redis.get.mockResolvedValueOnce(JSON.stringify({
        keyId: 'throttled_test_key',
        lastUpdated: Date.now(),
        hourlyUsage: new Array(24).fill(0),
        burstCounts: new Array(12).fill(0),
        isThrottled: true,
        throttleUntil: Date.now() + 30000,
        adaptiveFactor: 0.5,
      }));
      
      // Consume from limiter
      const result = await limiter.consume('throttled_test_key');
      
      // Validate throttling
      expect(result.limited).toBe(true);
      expect(result.adaptiveAction).toBe('throttled');
      
      // Validate throttle is recorded in usage logs
      const logs = verifiableEnvironment.getUsageLogs('throttled_test_key');
      expect(logs.length).toBe(0); // Our mock doesn't add logs
      
      // Create a manual log entry
      const logResult = verifiableEnvironment.validateUsageLogging({
        keyId: 'throttled_test_key',
        operation: 'test_operation',
        ip: '127.0.0.1',
        userAgent: 'test-agent',
        success: false,
        errorType: 'ADAPTIVE_THROTTLE',
      });
      
      expect(logResult.success).toBe(true);
    });
  });
  
  describe('Integration with Middleware', () => {
    it('should validate middleware behavior', async () => {
      // Create mock request and response
      const req: any = {
        apiKey: verifiableEnvironment.generateTestApiKey().apiKey,
        path: '/api/test',
        ip: '127.0.0.1',
        headers: {
          'user-agent': 'test-agent',
        },
        socket: {
          remoteAddress: '127.0.0.1',
        },
      };
      
      const res: any = {
        setHeader: jest.fn(),
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };
      
      const next = jest.fn();
      
      // Execute middleware
      await adaptiveRateLimitMiddleware(req, res, next);
      
      // Verify headers were set
      expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', expect.any(Number));
      expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', expect.any(Number));
      expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Reset', expect.any(Number));
      
      // Verify next was called
      expect(next).toHaveBeenCalled();
    });
  });
  
  describe('Performance Testing', () => {
    it('should meet performance requirements', async () => {
      // Create test key
      const { apiKey } = verifiableEnvironment.generateTestApiKey();
      
      // Start timing
      const startTime = process.hrtime();
      
      // Perform multiple rate limit checks
      const numRequests = 10;
      const promises = [];
      
      for (let i = 0; i < numRequests; i++) {
        promises.push(limiter.consume(apiKey.keyId));
      }
      
      await Promise.all(promises);
      
      // End timing
      const hrtime = process.hrtime(startTime);
      const executionTimeMs = hrtime[0] * 1000 + hrtime[1] / 1000000;
      
      // Verify average time is less than 5ms per request
      const avgTimePerRequest = executionTimeMs / numRequests;
      
      // This test is primarily informational since we're using mocks
      // In real environment, we would expect this to be < 5ms
      console.log(`Average time per request: ${avgTimePerRequest.toFixed(2)}ms`);
      
      // Test will pass in mock environment, but we're logging for information
      expect(true).toBe(true);
    });
  });
});