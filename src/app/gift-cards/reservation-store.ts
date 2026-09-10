import { randomUUID } from "crypto"

import { baseLogger } from "@services/logger"

// Loaded on first use rather than at import time: `@services/redis` constructs
// a live client as a module side effect, and this module is reachable from the
// GraphQL mutation's import graph (pattern: fygaro/checkout-intent-store.ts).
const redisClient = async () => (await import("@services/redis")).redis

/**
 * Per-account holds on the gift-card daily allowance.
 *
 * A reservation covers the window between `authorizeGiftCardPurchase` passing
 * and the order row existing in Mongo. Once the row exists it is what the
 * daily-cap sum counts (every non-failed order in the trailing 24h), so the
 * purchase path releases the hold immediately after `create` — a hold that
 * outlived the row would count the same money twice. Two concurrent
 * authorisations for one account therefore see each other's hold even though
 * neither has a row yet, which is the one race the repository cannot close.
 *
 * Storage is two keys, both bounded by `RESERVATION_TTL_SECONDS`:
 *
 *   giftcards:reservation:<accountId>:<id>   -> amount (minor units)
 *   giftcards:reservations:<accountId>       -> zset, score = expiry ms,
 *                                               member = "<amount>:<id>"
 *
 * The zset is the sum index (one ZRANGE, pruned by score on every read); the
 * per-reservation key is what lets `release(accountId, id)` find the member to
 * ZREM without the caller having to carry the amount around. Amount-first in
 * the member because the id is a UUID (no colon), so the split is unambiguous
 * and a malformed member parses to NaN and is dropped rather than summed.
 *
 * FAIL-CLOSED on read: an unreadable index is returned as the error, never as
 * "0 outstanding" — treating it as empty is exactly what would let a second
 * full-allowance order through while the first is still in flight. The caller
 * decides what that means per limits mode (`limitsUnavailable`).
 */
export const RESERVATION_TTL_SECONDS = 24 * 60 * 60

const reservationKey = (accountId: string, id: string) =>
  `giftcards:reservation:${accountId}:${id}`
const indexKey = (accountId: string) => `giftcards:reservations:${accountId}`

const member = (amountMinor: number, id: string) => `${amountMinor}:${id}`

const memberAmount = (m: string): number => {
  const amount = Number(m.slice(0, m.indexOf(":")))
  return Number.isFinite(amount) && amount > 0 ? amount : 0
}

export const newGiftCardReservationId = (): string => randomUUID()

export type GiftCardReservation = {
  id: string
  amountMinor: number
  expiresAtMs: number
}

export const writeGiftCardReservation = async ({
  accountId,
  amountMinor,
  nowMs,
  id = newGiftCardReservationId(),
}: {
  accountId: string
  amountMinor: number
  nowMs: number
  id?: string
}): Promise<string | Error> => {
  try {
    const redis = await redisClient()
    const expiresAtMs = nowMs + RESERVATION_TTL_SECONDS * 1000
    // Index first: it is the half the cap sum reads, so any early return below
    // leaves the hold in place rather than a dangling lookup key with no hold.
    await redis.zadd(indexKey(accountId), expiresAtMs, member(amountMinor, id))
    await redis.set(
      reservationKey(accountId, id),
      String(amountMinor),
      "EX",
      RESERVATION_TTL_SECONDS,
    )
    return id
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err))
  }
}

/** Live holds for the account. Expired members are pruned before the read. */
export const readGiftCardReservations = async ({
  accountId,
  nowMs,
}: {
  accountId: string
  nowMs: number
}): Promise<GiftCardReservation[] | Error> => {
  try {
    const redis = await redisClient()
    const key = indexKey(accountId)
    await redis.zremrangebyscore(key, "-inf", nowMs)
    const flat = await redis.zrange(key, 0, -1, "WITHSCORES")

    const reservations: GiftCardReservation[] = []
    for (let i = 0; i < flat.length; i += 2) {
      const m = flat[i]
      const amountMinor = memberAmount(m)
      if (amountMinor <= 0) continue
      const expiresAtMs = Number(flat[i + 1])
      reservations.push({
        id: m.slice(m.indexOf(":") + 1),
        amountMinor,
        expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : nowMs,
      })
    }
    return reservations
  } catch (err) {
    baseLogger.warn(
      { accountId, error: err instanceof Error ? err.constructor.name : String(err) },
      "Failed to read outstanding gift card reservations",
    )
    return err instanceof Error ? err : new Error(String(err))
  }
}

/**
 * Drop a hold. Best-effort: the hold expires with its TTL anyway, so the worst
 * case of a failed release is the allowance freeing up late, never early.
 * Releasing an id that is already gone is a no-op.
 */
export const releaseGiftCardReservation = async (
  accountId: string,
  reservationId: string | null | undefined,
): Promise<void> => {
  if (!reservationId) return
  try {
    const redis = await redisClient()
    const key = reservationKey(accountId, reservationId)
    const raw = await redis.get(key)
    if (raw !== null && raw !== undefined) {
      const amountMinor = Number(raw)
      if (Number.isFinite(amountMinor)) {
        await redis.zrem(indexKey(accountId), member(amountMinor, reservationId))
      }
    }
    await redis.del(key)
  } catch (err) {
    baseLogger.warn(
      {
        accountId,
        reservationId,
        error: err instanceof Error ? err.constructor.name : String(err),
      },
      "Failed to release gift card reservation; it will lapse at its TTL",
    )
  }
}
