import { RateLimiterRedis } from "rate-limiter-flexible"
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
const limits = { create: makeLimit("create", 60), status: makeLimit("status", 240) }
export const posOnChain = posOnChainFields(flashCheckout, async (ip, operation) => {
  try {
    await limits[operation].consume(ip)
  } catch {
    throw new CheckoutError("Checkout is busy. Retry this sale shortly.")
  }
})
