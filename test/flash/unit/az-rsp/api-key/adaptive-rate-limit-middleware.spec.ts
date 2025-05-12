import { adaptiveRateLimitMiddleware, getAdaptiveRateLimiter } from '@servers/middlewares/adaptive-rate-limit';
import { AdaptiveRateLimiter } from '@services/rate-limit/adaptive-rate-limiter';
import { Request, Response } from 'express';
import { ApiKeyService } from '@services/api-key';

// Mock the adaptive rate limiter
jest.mock('@services/rate-limit/adaptive-rate-limiter', () => {
  const mockConsume = jest.fn();
  
  return {
    AdaptiveRateLimiter: jest.fn().mockImplementation(() => ({
      consume: mockConsume,
    })),
    mockConsume, // Export for test access
  };
});

// Mock ApiKeyService
jest.mock('@services/api-key', () => ({
  ApiKeyService: jest.fn().mockImplementation(() => ({
    addUsageLog: jest.fn().mockResolvedValue(true),
  })),
}));

describe('Adaptive Rate Limit Middleware', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: jest.Mock;
  let mockConsume: jest.Mock;
  
  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();
    
    // Setup request and response mocks
    req = {
      apiKey: {
        keyId: 'test_key_id',
        metadata: { tier: 'TEST_TIER' },
      },
      path: '/api/test/endpoint',
      ip: '127.0.0.1',
      headers: {
        'user-agent': 'test-agent',
      },
      socket: {
        remoteAddress: '127.0.0.1',
      },
    };
    
    res = {
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    
    next = jest.fn();
    
    // Get the mock consume function
    mockConsume = require('@services/rate-limit/adaptive-rate-limiter').mockConsume;
  });
  
  it('should skip middleware if no API key is present', async () => {
    // Remove API key from request
    delete req.apiKey;
    
    await adaptiveRateLimitMiddleware(req as Request, res as Response, next);
    
    expect(mockConsume).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });
  
  it('should consume from rate limiter with correct parameters', async () => {
    // Setup mock to allow request
    mockConsume.mockResolvedValueOnce({
      limited: false,
      remainingPoints: 99,
      nextRefreshTime: new Date(Date.now() + 60000),
      adaptiveAction: null,
    });
    
    await adaptiveRateLimitMiddleware(req as Request, res as Response, next);
    
    // Verify consume was called with correct params
    expect(mockConsume).toHaveBeenCalledWith(
      'test_key_id',
      'TEST_TIER',
      'api_test_endpoint'
    );
    
    // Verify headers were set
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', 99);
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', expect.any(Number));
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Reset', expect.any(Number));
    
    // Verify next was called
    expect(next).toHaveBeenCalled();
  });
  
  it('should return 429 when rate limited', async () => {
    // Setup mock to limit request
    mockConsume.mockResolvedValueOnce({
      limited: true,
      remainingPoints: 0,
      nextRefreshTime: new Date(Date.now() + 60000),
      adaptiveAction: null,
    });
    
    await adaptiveRateLimitMiddleware(req as Request, res as Response, next);
    
    // Verify status and response
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: 'Too Many Requests',
    }));
    
    // Verify retry-after header
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(Number));
    
    // Verify next was not called
    expect(next).not.toHaveBeenCalled();
    
    // Verify usage log was added
    const apiKeyService = ApiKeyService();
    expect(apiKeyService.addUsageLog).toHaveBeenCalledWith(
      'test_key_id',
      expect.objectContaining({
        success: false,
        errorType: 'RATE_LIMIT_EXCEEDED',
      })
    );
  });
  
  it('should handle throttled keys appropriately', async () => {
    // Setup mock for throttled key
    mockConsume.mockResolvedValueOnce({
      limited: true,
      remainingPoints: 0,
      nextRefreshTime: new Date(Date.now() + 60000),
      adaptiveAction: 'throttled',
    });
    
    await adaptiveRateLimitMiddleware(req as Request, res as Response, next);
    
    // Verify status and response
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      message: 'API key has been temporarily throttled due to suspicious activity',
    }));
    
    // Verify appropriate adaptive headers
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Adaptive-Action', 'throttled');
    
    // Verify usage log with throttle error type
    const apiKeyService = ApiKeyService();
    expect(apiKeyService.addUsageLog).toHaveBeenCalledWith(
      'test_key_id',
      expect.objectContaining({
        errorType: 'ADAPTIVE_THROTTLE',
      })
    );
  });
  
  it('should continue to next middleware if an error occurs', async () => {
    // Setup mock to throw error
    mockConsume.mockRejectedValueOnce(new Error('Test error'));
    
    await adaptiveRateLimitMiddleware(req as Request, res as Response, next);
    
    // Verify next was called despite error
    expect(next).toHaveBeenCalled();
  });
  
  it('should use DEFAULT tier if no tier is specified in metadata', async () => {
    // Remove tier from metadata
    req.apiKey!.metadata = {};
    
    mockConsume.mockResolvedValueOnce({
      limited: false,
      remainingPoints: 99,
      nextRefreshTime: new Date(Date.now() + 60000),
      adaptiveAction: null,
    });
    
    await adaptiveRateLimitMiddleware(req as Request, res as Response, next);
    
    // Verify DEFAULT tier was used
    expect(mockConsume).toHaveBeenCalledWith(
      'test_key_id',
      'DEFAULT',
      expect.any(String)
    );
  });
  
  it('should handle different adaptive actions correctly', async () => {
    // Test increased action
    mockConsume.mockResolvedValueOnce({
      limited: false,
      remainingPoints: 120,
      nextRefreshTime: new Date(Date.now() + 60000),
      adaptiveAction: 'increased',
    });
    
    await adaptiveRateLimitMiddleware(req as Request, res as Response, next);
    
    // Verify headers for increased action
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Adaptive-Action', 'increased');
    
    // Reset mocks
    jest.clearAllMocks();
    
    // Test decreased action
    mockConsume.mockResolvedValueOnce({
      limited: false,
      remainingPoints: 80,
      nextRefreshTime: new Date(Date.now() + 60000),
      adaptiveAction: 'decreased',
    });
    
    await adaptiveRateLimitMiddleware(req as Request, res as Response, next);
    
    // Verify headers for decreased action
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Adaptive-Action', 'decreased');
  });
  
  it('should provide a singleton instance of AdaptiveRateLimiter', () => {
    // Get the limiter twice
    const limiter1 = getAdaptiveRateLimiter();
    const limiter2 = getAdaptiveRateLimiter();
    
    // Should be the same instance
    expect(limiter1).toBe(limiter2);
    
    // Should be an instance of AdaptiveRateLimiter
    expect(limiter1).toBeInstanceOf(AdaptiveRateLimiter);
  });
});