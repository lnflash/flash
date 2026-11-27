import { RateLimitConfig } from "@domain/rate-limit"
import {
  PosOnChainCheckoutIpRateLimiterExceededError,
  UnknownRateLimitServiceError,
} from "@domain/rate-limit/errors"
import { limitPosOnChainRequest } from "@graphql/public/pos-on-chain"
import { consumeLimiter } from "@services/rate-limit"

jest.mock("@services/rate-limit", () => ({ consumeLimiter: jest.fn() }))
jest.mock("@services/pos-on-chain/flash", () => ({ flashCheckout: () => null }))

const consume = consumeLimiter as jest.Mock
beforeEach(() => consume.mockReset())

it.each([
  ["supported", RateLimitConfig.posOnChainSupportedPerIp, 60],
  ["create", RateLimitConfig.posOnChainCreatePerIp, 60],
  ["status", RateLimitConfig.posOnChainStatusPerIp, 240],
] as const)(
  "charges %s to its own configured per-IP bucket",
  async (operation, config, points) => {
    consume.mockResolvedValue(true)
    await limitPosOnChainRequest("192.0.2.15", operation)
    expect(consume).toHaveBeenCalledWith({
      rateLimitConfig: config,
      keyToConsume: "192.0.2.15",
    })
    expect(config.limits).toEqual({ points, duration: 60, blockDuration: 0 })
  },
)

it("tells a limit breach apart from a limiter outage", async () => {
  consume.mockResolvedValueOnce(new PosOnChainCheckoutIpRateLimiterExceededError())
  await expect(limitPosOnChainRequest("192.0.2.15", "status")).rejects.toThrow(
    "Too many checkout requests. Try again shortly.",
  )
  consume.mockResolvedValueOnce(new UnknownRateLimitServiceError("redis down"))
  await expect(limitPosOnChainRequest("192.0.2.15", "status")).rejects.toThrow(
    "Checkout is temporarily unavailable. Try again shortly.",
  )
})
