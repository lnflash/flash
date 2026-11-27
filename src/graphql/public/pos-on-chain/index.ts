import { CheckoutError } from "@app/pos-on-chain/checkout"
import { RateLimitConfig } from "@domain/rate-limit"
import { RateLimiterExceededError } from "@domain/rate-limit/errors"
import { flashCheckout } from "@services/pos-on-chain/flash"
import { consumeLimiter } from "@services/rate-limit"

import { posOnChainFields } from "./fields"

const limits = {
  supported: RateLimitConfig.posOnChainSupportedPerIp,
  create: RateLimitConfig.posOnChainCreatePerIp,
  status: RateLimitConfig.posOnChainStatusPerIp,
}

export async function limitPosOnChainRequest(ip: string, operation: keyof typeof limits) {
  const result = await consumeLimiter({
    rateLimitConfig: limits[operation],
    keyToConsume: ip as IpAddress,
  })
  // consumeLimiter returns the config's exceeded error for a breach and a
  // RateLimitServiceError for a store fault; only the first is the caller's fault.
  if (result instanceof RateLimiterExceededError)
    throw new CheckoutError("Too many checkout requests. Try again shortly.")
  if (result instanceof Error)
    throw new CheckoutError("Checkout is temporarily unavailable. Try again shortly.")
}

export const posOnChain = posOnChainFields(flashCheckout, limitPosOnChainRequest)
