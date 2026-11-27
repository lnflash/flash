import { RateLimiterRedis, RateLimiterRes } from "rate-limiter-flexible"
import { redis } from "@services/redis"
import { CheckoutError } from "@app/pos-on-chain/checkout"
import { flashCheckout } from "@services/pos-on-chain/flash"
import { posOnChainFields } from "./fields"

const makeLimit = (kind: string, points: number) =>
  new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: "pos_onchain_" + kind,
    points,
    duration: 60,
  })
const limits = {
  supported: makeLimit("supported", 60),
  create: makeLimit("create", 60),
  status: makeLimit("status", 240),
}
export const posOnChain = posOnChainFields(flashCheckout, async (ip, operation) => {
  try {
    await limits[operation].consume(ip)
  } catch (err) {
    if (err instanceof RateLimiterRes) {
      throw new CheckoutError("Too many checkout requests. Try again shortly.")
    }
    throw new CheckoutError("Checkout is temporarily unavailable. Try again shortly.")
  }
})
