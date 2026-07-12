import { RateLimiterRedis } from "rate-limiter-flexible"

import { baseLogger } from "@services/logger"
import {
  API_KEY_REQUEST_LIMIT_PREFIX,
  consumeApiKeyRequestRateLimit,
} from "@services/rate-limit/api-keys"

jest.mock("rate-limiter-flexible", () => ({
  RateLimiterRedis: jest.fn(),
}))

// The real module opens redis connections at import time
jest.mock("@services/redis", () => ({
  redis: {},
}))

jest.mock("@services/logger", () => ({
  baseLogger: { warn: jest.fn() },
}))

const mockedRateLimiterRedis = RateLimiterRedis as jest.MockedClass<
  typeof RateLimiterRedis
>

// Shared across tests on purpose: the service caches one limiter per distinct
// limit at module scope, so a cached limiter must keep resolving to this mock
const consume = jest.fn()

// NOTE: because of that module-scoped cache, each test uses its own unique
// limitPerMinute value — constructor assertions filter by points
beforeEach(() => {
  consume.mockReset()
  mockedRateLimiterRedis.mockClear()
  mockedRateLimiterRedis.mockImplementation(
    () => ({ consume }) as unknown as RateLimiterRedis,
  )
})

describe("consumeApiKeyRequestRateLimit", () => {
  it("returns the allowed shape when consume resolves", async () => {
    consume.mockResolvedValue({ remainingPoints: 119, msBeforeNext: 45200 })

    const result = await consumeApiKeyRequestRateLimit({
      keyId: "a1b2c3d4",
      limitPerMinute: 120,
    })

    expect(consume).toHaveBeenCalledWith("a1b2c3d4", 1)
    expect(result).toEqual({
      allowed: true,
      limit: 120,
      remaining: 119,
      resetSeconds: 46,
    })
  })

  it("builds one 60s-window limiter per distinct limit and reuses it", async () => {
    consume.mockResolvedValue({ remainingPoints: 76, msBeforeNext: 1000 })

    await consumeApiKeyRequestRateLimit({ keyId: "key-a", limitPerMinute: 77 })
    await consumeApiKeyRequestRateLimit({ keyId: "key-b", limitPerMinute: 77 })

    const callsFor77 = mockedRateLimiterRedis.mock.calls.filter(
      (call) => call[0].points === 77,
    )
    expect(callsFor77).toHaveLength(1)
    expect(callsFor77[0][0]).toMatchObject({
      keyPrefix: API_KEY_REQUEST_LIMIT_PREFIX,
      points: 77,
      duration: 60,
    })
    expect(callsFor77[0][0].blockDuration).toBeUndefined()
    expect(consume).toHaveBeenCalledTimes(2)
  })

  it("returns the denied shape with a ceil'd retryAfterSeconds on limit exceed", async () => {
    // rate-limiter-flexible rejects with a RateLimiterRes-like value (not an
    // Error) when the limit is exceeded
    consume.mockRejectedValue({ msBeforeNext: 12001, remainingPoints: 0 })

    const result = await consumeApiKeyRequestRateLimit({
      keyId: "a1b2c3d4",
      limitPerMinute: 240,
    })

    expect(result).toEqual({
      allowed: false,
      limit: 240,
      remaining: 0,
      retryAfterSeconds: 13,
      resetSeconds: 13,
    })
  })

  it("clamps retryAfterSeconds to at least 1 second", async () => {
    consume.mockRejectedValue({ msBeforeNext: 0, remainingPoints: 0 })

    const result = await consumeApiKeyRequestRateLimit({
      keyId: "a1b2c3d4",
      limitPerMinute: 30,
    })

    expect(result).toMatchObject({ allowed: false, retryAfterSeconds: 1 })
  })

  it("fails open when redis is unavailable", async () => {
    consume.mockRejectedValue(new Error("Connection is closed."))

    const result = await consumeApiKeyRequestRateLimit({
      keyId: "a1b2c3d4",
      limitPerMinute: 60,
    })

    expect(result).toEqual({
      allowed: true,
      limit: 60,
      remaining: 60,
      resetSeconds: 60,
    })
    expect(baseLogger.warn).toHaveBeenCalled()
  })
})
