import { randomUUID } from "crypto"

import { baseLogger } from "@services/logger"

// Loaded on first use rather than at import time. `@services/cache` constructs
// a Redis client as a module side effect, and this module is imported by the
// Fygaro webhook route — eagerly importing it would drag a live Redis
// connection into every consumer of that route, including its unit tests.
const cacheService = async () => (await import("@services/cache")).RedisCacheService()

/**
 * What the server authorised, so the webhook can check what actually got paid
 * against it.
 *
 * The signed JWT already prevents the customer editing the amount, so this is
 * not the primary defence — it is the record that lets us verify the two
 * independently, catch a signing/config mistake on our side, and make each
 * authorisation single-use. Losing this store degrades a payment to the legacy
 * unverified path; it never blocks a credit on its own (see consumeIntent).
 */
export type FygaroCheckoutIntent = {
  intentId: string
  accountId: string
  username: string
  amountCents: number
  currency: string
  createdAtMs: number
}

const cacheKey = (intentId: string) => `fygaro-checkout-intent:${intentId}`

export const newIntentId = (): string => randomUUID()

export const saveIntent = async ({
  intent,
  ttlSeconds,
}: {
  intent: FygaroCheckoutIntent
  ttlSeconds: number
}): Promise<true | Error> => {
  // Outlive the JWT by a margin: a payment authorised at the very end of the
  // token's window still arrives (and must still be verifiable) minutes later,
  // once the customer has finished typing their card details.
  const res = await (
    await cacheService()
  ).set<FygaroCheckoutIntent>({
    key: cacheKey(intent.intentId),
    value: intent,
    ttlSecs: (ttlSeconds + 3600) as Seconds,
  })
  if (res instanceof Error) return res
  return true
}

export type IntentLookup =
  | { found: true; intent: FygaroCheckoutIntent }
  // Expired, evicted, already consumed, or minted by a different deployment.
  | { found: false }

/**
 * Read an intent and immediately invalidate it, so a replayed webhook cannot
 * present the same authorisation twice.
 *
 * A cache failure returns `found: false` rather than an error: the caller
 * treats an unverifiable intent as "no authorisation on file" and falls through
 * to the credit gate, which is the same position every legacy payment is in.
 * Failing the credit outright here would turn a Redis blip into stuck customer
 * funds — the exact outcome this whole workstream exists to avoid.
 */
export const consumeIntent = async (intentId: string): Promise<IntentLookup> => {
  const cache = await cacheService()
  const found = await cache.get<FygaroCheckoutIntent>({ key: cacheKey(intentId) })
  if (found instanceof Error) {
    baseLogger.warn(
      { intentId, error: found.constructor.name },
      "Fygaro checkout intent lookup failed; treating payment as unauthorised-legacy",
    )
    return { found: false }
  }

  const cleared = await cache.clear({ key: cacheKey(intentId) })
  if (cleared instanceof Error) {
    // The credit itself is still exactly-once downstream (the webhook dedupes
    // on transactionId), so a failed clear cannot double-credit — it only means
    // a replay would re-verify against a live intent instead of falling back.
    baseLogger.warn({ intentId }, "Failed to clear consumed Fygaro checkout intent")
  }

  return { found: true, intent: found }
}
