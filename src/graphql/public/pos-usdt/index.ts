import { UsdtCheckoutError } from "@app/pos-usdt-checkout/checkout"
import { RateLimitConfig } from "@domain/rate-limit"
import { RateLimiterExceededError } from "@domain/rate-limit/errors"
import { flashUsdtCheckout } from "@services/pos-usdt-checkout/flash"
import { consumeLimiter } from "@services/rate-limit"

import { posUsdtFields } from "./fields"

const limits = {
  supported: RateLimitConfig.posUsdtSupportedPerIp,
  create: RateLimitConfig.posUsdtCreatePerIp,
  status: RateLimitConfig.posUsdtStatusPerIp,
}

export async function limitPosUsdtRequest(ip: string, operation: keyof typeof limits) {
  const result = await consumeLimiter({
    rateLimitConfig: limits[operation],
    keyToConsume: ip as IpAddress,
  })
  if (result instanceof RateLimiterExceededError)
    throw new UsdtCheckoutError("Too many checkout requests. Try again shortly.")
  if (result instanceof Error)
    throw new UsdtCheckoutError("Checkout is temporarily unavailable. Try again shortly.")
}

export const posUsdt = posUsdtFields(flashUsdtCheckout, limitPosUsdtRequest)
