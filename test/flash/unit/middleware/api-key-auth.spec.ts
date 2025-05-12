import { apiKeyAuthMiddleware } from "@servers/middlewares/api-key-auth"
import { ApiKeyService } from "@services/api-keys"
import { ApiKeyStatus, Scope } from "@domain/api-keys"
import { ApiKeyLookupByKeyResult } from "@domain/api-keys/index.types"
import { Request, Response } from "express"
import { AdaptiveRateLimiter } from "@services/rate-limit/adaptive-rate-limiter"
import { ApiKeyInvalidError, ApiKeyRevokedError } from "@domain/api-keys/errors"

// Mock the API key service
jest.mock("@services/api-keys", () => ({
  ApiKeyService: {
    verifyKey: jest.fn(),
    logUsage: jest.fn(),
  },
}))

// Mock the rate limiter
jest.mock("@services/rate-limit/adaptive-rate-limiter", () => ({
  AdaptiveRateLimiter: jest.fn().mockImplementation(() => ({
    consume: jest.fn(),
  })),
}))

describe("API Key Authentication Middleware", () => {
  let req: Partial<Request>
  let res: Partial<Response>
  let next: jest.Mock
  let mockApiKey: ApiKeyLookupByKeyResult
  let mockRateLimitResult: { limited: boolean; limit: number; remaining: number; resetTime: number }

  beforeEach(() => {
    jest.clearAllMocks()

    // Setup mock request, response, and next function
    req = {
      header: jest.fn(),
      query: {},
      path: "/graphql",
      ip: "127.0.0.1",
      apiKey: undefined,
    }

    res = {
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      on: jest.fn(),
      statusCode: 200,
    }

    next = jest.fn()

    // Setup mock API key data
    mockApiKey = {
      id: "api123",
      accountId: "account123",
      hashedKey: "hashedKey123",
      scopes: ["read:account", "read:wallet"] as Scope[],
      status: ApiKeyStatus.Active,
      expiresAt: null,
      tier: "DEFAULT",
    }

    // Setup mock rate limit result
    mockRateLimitResult = {
      limited: false,
      limit: 100,
      remaining: 99,
      resetTime: Date.now() + 60000,
    }

    // Mock API key service and rate limiter
    ;(ApiKeyService.verifyKey as jest.Mock).mockResolvedValue(mockApiKey)
    ;(AdaptiveRateLimiter.prototype.consume as jest.Mock).mockResolvedValue(mockRateLimitResult)
  })

  it("should authenticate a request with a valid API key in the header", async () => {
    // Setup mock request with API key in header
    ;(req.header as jest.Mock).mockImplementation((name) => {
      if (name === "Authorization") {
        return "ApiKey flash_test_12345abcdef"
      }
      return null
    })

    // Create middleware with no required scopes
    const middleware = apiKeyAuthMiddleware()

    // Execute middleware
    await middleware(req as Request, res as Response, next)

    // Verify API key was verified
    expect(ApiKeyService.verifyKey).toHaveBeenCalledWith("flash_test_12345abcdef", undefined)

    // Verify rate limit headers were set
    expect(res.setHeader).toHaveBeenCalledWith("X-RateLimit-Limit", "100")
    expect(res.setHeader).toHaveBeenCalledWith("X-RateLimit-Remaining", "99")

    // Verify API key context was set
    expect(req.apiKey).toEqual({
      id: mockApiKey.id,
      accountId: mockApiKey.accountId,
      scopes: mockApiKey.scopes,
    })

    // Verify next was called
    expect(next).toHaveBeenCalled()
  })

  it("should authenticate a request with a valid API key in query parameter", async () => {
    // Setup mock request with API key in query parameter
    req.query = { apiKey: "flash_test_12345abcdef" }

    // Create middleware with no required scopes
    const middleware = apiKeyAuthMiddleware()

    // Execute middleware
    await middleware(req as Request, res as Response, next)

    // Verify API key was verified
    expect(ApiKeyService.verifyKey).toHaveBeenCalledWith("flash_test_12345abcdef", undefined)

    // Verify next was called
    expect(next).toHaveBeenCalled()
  })

  it("should continue to next middleware if no API key is provided", async () => {
    // Setup mock request with no API key
    ;(req.header as jest.Mock).mockReturnValue(null)
    req.query = {}

    // Create middleware with no required scopes
    const middleware = apiKeyAuthMiddleware()

    // Execute middleware
    await middleware(req as Request, res as Response, next)

    // Verify API key was not verified
    expect(ApiKeyService.verifyKey).not.toHaveBeenCalled()

    // Verify next was called
    expect(next).toHaveBeenCalled()
  })

  it("should require specific scopes when specified", async () => {
    // Setup mock request with API key in header
    ;(req.header as jest.Mock).mockImplementation((name) => {
      if (name === "Authorization") {
        return "ApiKey flash_test_12345abcdef"
      }
      return null
    })

    // Create middleware with required scopes
    const middleware = apiKeyAuthMiddleware(["read:account"] as Scope[])

    // Execute middleware
    await middleware(req as Request, res as Response, next)

    // Verify API key was verified with required scopes
    expect(ApiKeyService.verifyKey).toHaveBeenCalledWith(
      "flash_test_12345abcdef",
      ["read:account"]
    )

    // Verify next was called
    expect(next).toHaveBeenCalled()
  })

  it("should return 401 for invalid API key", async () => {
    // Setup mock request with API key in header
    ;(req.header as jest.Mock).mockImplementation((name) => {
      if (name === "Authorization") {
        return "ApiKey invalid_api_key"
      }
      return null
    })

    // Mock API key service to throw error
    ;(ApiKeyService.verifyKey as jest.Mock).mockRejectedValue(new ApiKeyInvalidError())

    // Create middleware with no required scopes
    const middleware = apiKeyAuthMiddleware()

    // Execute middleware
    await middleware(req as Request, res as Response, next)

    // Verify status and response
    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith({
      error: "Invalid API key",
      code: "INVALID_API_KEY",
    })

    // Verify next was not called
    expect(next).not.toHaveBeenCalled()
  })

  it("should return 401 for revoked API key", async () => {
    // Setup mock request with API key in header
    ;(req.header as jest.Mock).mockImplementation((name) => {
      if (name === "Authorization") {
        return "ApiKey flash_test_12345abcdef"
      }
      return null
    })

    // Mock API key service to throw error
    ;(ApiKeyService.verifyKey as jest.Mock).mockRejectedValue(new ApiKeyRevokedError())

    // Create middleware with no required scopes
    const middleware = apiKeyAuthMiddleware()

    // Execute middleware
    await middleware(req as Request, res as Response, next)

    // Verify status and response
    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith({
      error: "API key has been revoked",
      code: "REVOKED_API_KEY",
    })

    // Verify next was not called
    expect(next).not.toHaveBeenCalled()
  })

  it("should return 429 when rate limit is exceeded", async () => {
    // Setup mock request with API key in header
    ;(req.header as jest.Mock).mockImplementation((name) => {
      if (name === "Authorization") {
        return "ApiKey flash_test_12345abcdef"
      }
      return null
    })

    // Mock rate limiter to return limited=true
    ;(AdaptiveRateLimiter.prototype.consume as jest.Mock).mockResolvedValue({
      ...mockRateLimitResult,
      limited: true,
    })

    // Create middleware with no required scopes
    const middleware = apiKeyAuthMiddleware()

    // Execute middleware
    await middleware(req as Request, res as Response, next)

    // Verify status and response
    expect(res.status).toHaveBeenCalledWith(429)
    expect(res.json).toHaveBeenCalledWith({
      error: "Rate limit exceeded",
      code: "RATE_LIMIT_EXCEEDED",
    })

    // Verify next was not called
    expect(next).not.toHaveBeenCalled()
  })
})