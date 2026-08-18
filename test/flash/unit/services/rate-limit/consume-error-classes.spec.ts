import {
  RateLimiterExceededError,
  UnknownRateLimitServiceError,
} from "@domain/rate-limit/errors"
import { RateLimiterRes } from "rate-limiter-flexible"

const mockConsume = jest.fn()

jest.mock("rate-limiter-flexible", () => {
  const actual = jest.requireActual("rate-limiter-flexible")
  return {
    ...actual,
    RateLimiterRedis: jest.fn().mockImplementation(() => ({
      consume: (...args: unknown[]) => mockConsume(...args),
      delete: jest.fn(),
      reward: jest.fn(),
    })),
  }
})
jest.mock("@services/redis", () => ({ redis: {} }))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { RedisRateLimitService, consumeLimiter } = require("@services/rate-limit")

const limiter = () =>
  RedisRateLimitService({
    keyPrefix: "test_prefix",
    limitOptions: { points: 3, duration: 60, blockDuration: 300 },
  })

class TestExceededError extends RateLimiterExceededError {}

beforeEach(() => jest.clearAllMocks())

describe("rate limiter: a store fault is not a limit breach", () => {
  it("reports a real breach as exceeded", async () => {
    mockConsume.mockRejectedValue(new RateLimiterRes(0, 60_000, 3, false))

    expect(await limiter().consume("key")).toBeInstanceOf(RateLimiterExceededError)
  })

  it("reports a Redis outage as a service error, NOT as exceeded", async () => {
    // With no insuranceLimiter configured, rate-limiter-flexible rejects with
    // the raw store error. Collapsing that into "exceeded" tells every user
    // they are rate limited on their first request of the day and hides the
    // outage from whoever is on call.
    mockConsume.mockRejectedValue(new Error("MaxRetriesPerRequestError"))

    const res = await limiter().consume("key")
    expect(res).toBeInstanceOf(UnknownRateLimitServiceError)
    expect(res).not.toBeInstanceOf(RateLimiterExceededError)
  })

  it("passes on success", async () => {
    mockConsume.mockResolvedValue(undefined)

    expect(await limiter().consume("key")).toBe(true)
  })

  describe("consumeLimiter", () => {
    const config = {
      key: "test_prefix",
      limits: { points: 3, duration: 60, blockDuration: 300 },
      error: TestExceededError,
    }

    it("translates a breach into the caller's own error", async () => {
      mockConsume.mockRejectedValue(new RateLimiterRes(0, 60_000, 3, false))

      expect(
        await consumeLimiter({ rateLimitConfig: config, keyToConsume: "acct" }),
      ).toBeInstanceOf(TestExceededError)
    })

    it("does not disguise a store fault as the caller's rate-limit error", async () => {
      // The caller has to be able to tell the two apart to decide whether
      // refusing is the honest answer.
      mockConsume.mockRejectedValue(new Error("ECONNREFUSED"))

      const res = await consumeLimiter({ rateLimitConfig: config, keyToConsume: "acct" })
      expect(res).toBeInstanceOf(UnknownRateLimitServiceError)
      expect(res).not.toBeInstanceOf(TestExceededError)
    })
  })
})
