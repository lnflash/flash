import { RateLimitConfig } from "@domain/rate-limit"
import {
  InviteCreateRateLimiterExceededError,
  InviteTargetRateLimiterExceededError,
} from "@domain/rate-limit/errors"
import { consumeLimiter } from "@services/rate-limit"

export const checkInviteCreateRateLimit = async (
  accountId: AccountId,
): Promise<true | InviteCreateRateLimiterExceededError> =>
  consumeLimiter({
    rateLimitConfig: RateLimitConfig.inviteCreate,
    keyToConsume: accountId,
  })

export const checkInviteTargetRateLimit = async (
  contact: string,
): Promise<true | InviteTargetRateLimiterExceededError> =>
  consumeLimiter({
    rateLimitConfig: RateLimitConfig.inviteTarget,
    keyToConsume: contact as IpAddress, // Contact string used as rate limit key
  })
