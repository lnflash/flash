import { RateLimitConfig } from "@domain/rate-limit"
import { InviteCreateRateLimiterExceededError } from "@domain/rate-limit/errors"

const mockConsumeLimiter = jest.fn()
jest.mock("@services/rate-limit", () => ({
  consumeLimiter: (args: unknown) => mockConsumeLimiter(args),
}))

import {
  checkInviteCreateRateLimit,
  checkInviteTargetRateLimit,
} from "@app/invite/rate-limits"

describe("invite rate-limits", () => {
  beforeEach(() => jest.clearAllMocks())

  describe("checkInviteCreateRateLimit", () => {
    it("consumes the inviteCreate limiter keyed by accountId and passes through true", async () => {
      mockConsumeLimiter.mockResolvedValue(true)
      const accountId = "507f1f77bcf86cd799439011" as AccountId

      const result = await checkInviteCreateRateLimit(accountId)

      expect(result).toBe(true)
      expect(mockConsumeLimiter).toHaveBeenCalledWith({
        rateLimitConfig: RateLimitConfig.inviteCreate,
        keyToConsume: accountId,
      })
    })

    it("returns the limiter error when exceeded", async () => {
      const err = new InviteCreateRateLimiterExceededError()
      mockConsumeLimiter.mockResolvedValue(err)

      const result = await checkInviteCreateRateLimit("507f1f77bcf86cd799439011" as AccountId)

      expect(result).toBe(err)
    })
  })

  describe("checkInviteTargetRateLimit", () => {
    it("consumes the inviteTarget limiter keyed by contact", async () => {
      mockConsumeLimiter.mockResolvedValue(true)

      const result = await checkInviteTargetRateLimit("+12025550123")

      expect(result).toBe(true)
      expect(mockConsumeLimiter).toHaveBeenCalledWith({
        rateLimitConfig: RateLimitConfig.inviteTarget,
        keyToConsume: "+12025550123",
      })
    })
  })
})
