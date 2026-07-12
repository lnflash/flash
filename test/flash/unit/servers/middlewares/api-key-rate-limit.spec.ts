import { NextFunction, Request, Response } from "express"

import { consumeApiKeyRequestRateLimit } from "@services/rate-limit/api-keys"
import { apiKeyRateLimitMiddleware } from "@servers/middlewares/api-key-rate-limit"
import { auditApiKeyRateLimited } from "@services/api-keys-audit"
import { incApiKeyRateLimited } from "@services/api-keys-metrics"

jest.mock("@config", () => ({
  getApiKeyConfig: jest.fn(() => ({
    maxKeysPerAccount: 10,
    defaultRequestsPerMinute: 120,
  })),
}))

jest.mock("@services/rate-limit/api-keys", () => ({
  consumeApiKeyRequestRateLimit: jest.fn(),
}))

jest.mock("@services/logger", () => ({
  baseLogger: { warn: jest.fn() },
}))

jest.mock("@services/api-keys-metrics", () => ({
  incApiKeyRateLimited: jest.fn(),
}))

jest.mock("@services/api-keys-audit", () => ({
  auditApiKeyRateLimited: jest.fn(),
}))

const mockedConsume = consumeApiKeyRequestRateLimit as jest.MockedFunction<
  typeof consumeApiKeyRequestRateLimit
>
const mockedIncRateLimited = incApiKeyRateLimited as jest.MockedFunction<
  typeof incApiKeyRateLimited
>
const mockedAuditRateLimited = auditApiKeyRateLimited as jest.MockedFunction<
  typeof auditApiKeyRateLimited
>

const makeReq = ({
  sessionId,
  token,
}: {
  sessionId?: string
  token?: Record<string, unknown>
} = {}) =>
  ({
    gqlContext: sessionId === undefined ? undefined : { sessionId },
    token,
  }) as unknown as Request

const makeRes = () => {
  const res = {
    set: jest.fn(),
    status: jest.fn(),
    json: jest.fn(),
  }
  res.status.mockReturnValue(res)
  return res as unknown as Response & {
    set: jest.Mock
    status: jest.Mock
    json: jest.Mock
  }
}

describe("apiKeyRateLimitMiddleware", () => {
  let next: jest.MockedFunction<NextFunction>

  beforeEach(() => {
    mockedConsume.mockReset()
    mockedIncRateLimited.mockReset()
    mockedAuditRateLimited.mockReset()
    next = jest.fn()
  })

  it("passes kratos sessions through untouched", async () => {
    const res = makeRes()

    await apiKeyRateLimitMiddleware(
      makeReq({ sessionId: "9f8e7d6c-kratos-session" }),
      res,
      next,
    )

    expect(next).toHaveBeenCalled()
    expect(mockedConsume).not.toHaveBeenCalled()
    expect(res.set).not.toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
  })

  it("passes requests without a gqlContext session through untouched", async () => {
    const res = makeRes()

    await apiKeyRateLimitMiddleware(makeReq(), res, next)

    expect(next).toHaveBeenCalled()
    expect(mockedConsume).not.toHaveBeenCalled()
    expect(res.set).not.toHaveBeenCalled()
  })

  it("consumes with the keyId and the token's rate_limit claim, sets headers, and continues when allowed", async () => {
    mockedConsume.mockResolvedValue({
      allowed: true,
      limit: 300,
      remaining: 299,
      resetSeconds: 30,
    })
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(1760000000000)
    const res = makeRes()

    await apiKeyRateLimitMiddleware(
      makeReq({ sessionId: "apikey:a1b2c3d4", token: { rate_limit: 300 } }),
      res,
      next,
    )

    expect(mockedConsume).toHaveBeenCalledWith({
      keyId: "a1b2c3d4",
      limitPerMinute: 300,
    })
    expect(res.set).toHaveBeenCalledWith("X-RateLimit-Limit", "300")
    expect(res.set).toHaveBeenCalledWith("X-RateLimit-Remaining", "299")
    expect(res.set).toHaveBeenCalledWith("X-RateLimit-Reset", "1760000030")
    expect(next).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
    expect(mockedIncRateLimited).not.toHaveBeenCalled()
    expect(mockedAuditRateLimited).not.toHaveBeenCalled()

    nowSpy.mockRestore()
  })

  it("falls back to the config default limit when the rate_limit claim is absent", async () => {
    mockedConsume.mockResolvedValue({
      allowed: true,
      limit: 120,
      remaining: 119,
      resetSeconds: 60,
    })
    const res = makeRes()

    await apiKeyRateLimitMiddleware(
      makeReq({ sessionId: "apikey:a1b2c3d4", token: { sub: "some-user" } }),
      res,
      next,
    )

    expect(mockedConsume).toHaveBeenCalledWith({
      keyId: "a1b2c3d4",
      limitPerMinute: 120,
    })
  })

  it("short-circuits with a 429, Retry-After, and a JSON body when denied", async () => {
    mockedConsume.mockResolvedValue({
      allowed: false,
      limit: 120,
      remaining: 0,
      retryAfterSeconds: 13,
      resetSeconds: 13,
    })
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(1760000000000)
    const res = makeRes()

    await apiKeyRateLimitMiddleware(
      makeReq({ sessionId: "apikey:a1b2c3d4", token: { rate_limit: 120 } }),
      res,
      next,
    )

    expect(res.set).toHaveBeenCalledWith("X-RateLimit-Limit", "120")
    expect(res.set).toHaveBeenCalledWith("X-RateLimit-Remaining", "0")
    expect(res.set).toHaveBeenCalledWith("X-RateLimit-Reset", "1760000013")
    expect(res.set).toHaveBeenCalledWith("Retry-After", "13")
    expect(res.status).toHaveBeenCalledWith(429)
    expect(res.json).toHaveBeenCalledWith({
      error: { code: "TOO_MANY_REQUESTS", message: "API key rate limit exceeded" },
    })
    expect(next).not.toHaveBeenCalled()
    expect(mockedIncRateLimited).toHaveBeenCalledTimes(1)
    expect(mockedAuditRateLimited).toHaveBeenCalledWith({ keyId: "a1b2c3d4" })

    nowSpy.mockRestore()
  })

  it("fails open when the limiter service throws", async () => {
    mockedConsume.mockRejectedValue(new Error("unexpected"))
    const res = makeRes()

    await apiKeyRateLimitMiddleware(
      makeReq({ sessionId: "apikey:a1b2c3d4", token: { rate_limit: 120 } }),
      res,
      next,
    )

    expect(next).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
  })
})
