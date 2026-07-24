import { createHash } from "crypto"

import { IdempotencyKeyReuseError, InvalidIdempotencyKeyError } from "@domain/errors"
import { ErrorLevel } from "@domain/shared"

import { RedisCacheService } from "@services/cache"
import { LockService } from "@services/lock"
import { recordExceptionInCurrentSpan } from "@services/tracing"

// How long a completed payment-send result is replayable under its idempotency key.
const IDEMPOTENCY_TTL_SECS = (24 * 60 * 60) as Seconds // 24h
const MAX_KEY_LENGTH = 256

const cacheKeyFor = (scopedKey: string) => `payment-idempotency:${scopedKey}`
const fingerprintOf = (requestFingerprint: string) =>
  createHash("sha256").update(requestFingerprint).digest("hex")

type PaymentSendResult = PaymentSendStatus | ApplicationError
// The cached envelope binds the stored result to the request that produced it, so a
// key reused for a *different* payment is rejected rather than silently replayed.
type CachedPaymentSend = { fingerprint: string; result: PaymentSendStatus }

/**
 * ENG-530: server-side idempotency for payment-send mutations.
 *
 * Wraps an exported send function so a repeated request with the same
 * client-supplied `idempotencyKey` returns the original result instead of
 * executing (and paying) again — exactly-once settlement.
 *
 * The dedupe is scoped to `(senderWalletId, idempotencyKey)`, and the cached result
 * is bound to a `requestFingerprint` of the parameters that identify the payment
 * (recipient/invoice + amount). The same key from different wallets never collides,
 * and the same key reused for a *different* payment is rejected (see below).
 *
 * Behavior when a key is supplied:
 *  - Completed result cached, same fingerprint → returns the stored result.
 *    `execute()` is never called, so no new IBEX invoice is minted, no second
 *    payment, and (because the ops-event notify lives inside `execute`) no duplicate
 *    ops event fires.
 *  - Completed result cached, DIFFERENT fingerprint → returns `IdempotencyKeyReuseError`
 *    and does NOT execute. Replaying the original result here would silently drop the
 *    new payment while reporting the old one's success. This check runs on both the
 *    fast path and the in-lock re-check.
 *  - Concurrent in-flight (lock held) → returns the busy lock error rather than
 *    executing a second time.
 *  - First request → acquires the lock, executes, persists `{fingerprint, result}`
 *    under the key (TTL), releases the lock.
 *
 * No key (absent / blank) → runs `execute()` unchanged; existing clients and internal
 * callers are unaffected.
 *
 * Only a definitive payment outcome (a `PaymentSendStatus`) is cached. An
 * `ApplicationError` return (validation / transient failure) is left uncached so a
 * fresh attempt with the same key can retry. The lock still guards the concurrent
 * window regardless of caching.
 *
 * Reuses existing primitives: `RedisCacheService` for the result store and
 * `LockService().lockPaymentIdempotencyKey` (a redlock `.using` lock that releases
 * when `execute` finishes) for the in-flight guard.
 *
 * CLIENT CONTRACT: a client that receives the busy/lock error MUST retry with the
 * SAME idempotency key. Retrying with a NEW key can double-pay (the original request
 * may still be settling). Likewise, a genuinely new payment MUST use a new key.
 *
 * KNOWN GAP (unchanged from pre-idempotency behavior, not fixed here): if IBEX
 * actually debited but returned an error to us, `execute` returns an ApplicationError
 * that is not cached, so a same-key retry after the lock releases can re-pay. The lock
 * covers the concurrent window; the residual retry-after-partial-success case is
 * mitigated only once IBEX exposes request-level idempotency of its own.
 */
export const withPaymentIdempotency = async ({
  idempotencyKey,
  senderWalletId,
  requestFingerprint,
  execute,
}: {
  idempotencyKey: string | null | undefined
  senderWalletId: WalletId
  requestFingerprint: string
  execute: () => Promise<PaymentSendResult>
}): Promise<PaymentSendResult> => {
  // No key supplied → unchanged behavior.
  if (!idempotencyKey) return execute()

  const trimmedKey = idempotencyKey.trim()
  // A blank / whitespace-only key is treated as "no key" (unchanged behavior).
  if (trimmedKey.length === 0) return execute()
  if (trimmedKey.length > MAX_KEY_LENGTH) {
    return new InvalidIdempotencyKeyError(idempotencyKey)
  }

  const scopedKey = `${senderWalletId}:${trimmedKey}` as IdempotencyKey
  const cacheKey = cacheKeyFor(scopedKey)
  const fingerprint = fingerprintOf(requestFingerprint)
  const cache = RedisCacheService()

  // Resolve a cache entry: replay on a fingerprint match, reject on a mismatch.
  const resolveCached = (entry: CachedPaymentSend): PaymentSendResult =>
    entry.fingerprint === fingerprint ? entry.result : new IdempotencyKeyReuseError()

  // 1. Fast path — a completed result is already stored.
  const cached = await cache.get<CachedPaymentSend>({ key: cacheKey })
  if (!(cached instanceof Error)) return resolveCached(cached)

  // 2. Acquire a short lock on the scoped key, execute under it, persist the
  //    outcome, then release (the lock auto-releases when the callback returns).
  return LockService().lockPaymentIdempotencyKey<PaymentSendResult>(
    scopedKey,
    async () => {
      // Re-check inside the lock to close the check-then-act race with a
      // concurrent request that completed between our fast-path miss and here.
      const cachedInLock = await cache.get<CachedPaymentSend>({ key: cacheKey })
      if (!(cachedInLock instanceof Error)) return resolveCached(cachedInLock)

      const outcome = await execute()

      // Persist only a definitive payment outcome. Errors stay uncached so a
      // fresh attempt with the same key can retry.
      if (!(outcome instanceof Error)) {
        const setResult = await cache.set<CachedPaymentSend>({
          key: cacheKey,
          value: { fingerprint, result: outcome },
          ttlSecs: IDEMPOTENCY_TTL_SECS,
        })

        // The payment already executed. If persisting its result failed, a later
        // retry with this key would re-execute and double-pay. We can't un-pay —
        // make it loud so ops can intervene.
        if (setResult instanceof Error) {
          recordExceptionInCurrentSpan({
            error: setResult,
            level: ErrorLevel.Critical,
            fallbackMsg:
              "Payment idempotency: cache.set failed after a completed send; a retry with this key could double-pay",
            attributes: {
              "idempotency.scopedKey": scopedKey,
              "idempotency.status": JSON.stringify(outcome),
            },
          })
        }
      }

      return outcome
    },
  )
  // If the lock could not be acquired, `lockPaymentIdempotencyKey` returns a
  // LockServiceError (⊆ ApplicationError) — a concurrent same-key request is in
  // flight. We surface that busy error and never execute a second time.
}
