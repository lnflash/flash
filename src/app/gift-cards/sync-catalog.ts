import { randomBytes } from "crypto"

import { GiftCardError, UnknownGiftCardError } from "@domain/gift-cards"
import { notifyOpsEvent } from "@services/alerts/ops-events"
import { enabledGiftCardProviders } from "@services/gift-cards"
import { GiftCardCatalogCache } from "@services/gift-cards/catalog-cache"
import { baseLogger } from "@services/logger"
import { wrapAsyncFunctionsToRunInSpan } from "@services/tracing"

// Lazy for the same reason as the catalog cache: `@services/redis` opens a
// connection at import time, and this module is pulled in by the cron entry
// point and by unit tests that never want one.
const redisClient = async () => (await import("@services/redis")).redis

/**
 * Pulls every enabled vendor's full catalog into the Redis read model.
 *
 * `IGiftCardProvider.listProducts` is the one vendor call that is never on a
 * request path — it is this job's, and only this job's, to make. One provider
 * failing must not cost the others their refresh, so each is synced on its own
 * and reported on its own; the summary the cron logs is whatever succeeded.
 *
 * Concurrency: the cron Job is one-shot and k8s may start the next run before a
 * slow vendor pull has finished, so the whole pass sits behind a Redis
 * `SET NX EX` lock. A held lock means another run is already doing this work
 * and we return `[]`; a lock we cannot reach means Redis is down, and since the
 * catalog is written TO Redis there is nothing useful to do either.
 */
export type GiftCardCatalogSyncSummary = {
  providerId: GiftCardProviderId
  products: number
  countries: number
  durationMs: number
}

export const GIFT_CARD_CATALOG_SYNC_LOCK_KEY = "giftcards:catalog-sync:lock"
export const GIFT_CARD_CATALOG_SYNC_LOCK_TTL_SECONDS = 10 * 60

// Throttle marker for callers that honour `catalog.syncIntervalSeconds` (the
// cron runs far more often than the catalog needs refreshing). Separate from
// the lock: the lock says "a run is in flight", the marker says "a run finished
// recently".
export const GIFT_CARD_CATALOG_SYNC_MARKER_KEY = "giftcards:catalog-sync:last-run"

// Release only the lock WE took. A plain DEL after a run that outlived the TTL
// would free a lock some newer run now holds.
const RELEASE_IF_OWNER = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`

const syncForProvider = async (
  provider: IGiftCardProvider,
): Promise<GiftCardCatalogSyncSummary | ApplicationError> => {
  const start = Date.now()
  const providerId = provider.id

  const fail = (err: ApplicationError): ApplicationError => {
    baseLogger.error({ providerId, err }, "gift card catalog sync failed")
    notifyOpsEvent({
      flow: "giftcard",
      phase: "catalog-sync-failed",
      status: "failed",
      error: err.name,
      meta: { providerId },
    })
    return err
  }

  let products: GiftCardProduct[] | GiftCardError
  try {
    products = await provider.listProducts()
  } catch (err) {
    // The port says "return an error, never throw"; an adapter bug that throws
    // anyway must not take the other providers down with it.
    return fail(new UnknownGiftCardError(err))
  }
  if (products instanceof Error) return fail(products)

  const written = await GiftCardCatalogCache().write({
    providerId,
    products,
    syncedAt: new Date(),
  })
  if (written instanceof Error) return fail(written)

  const summary: GiftCardCatalogSyncSummary = {
    providerId,
    products: products.length,
    countries: written.countries.length,
    durationMs: Date.now() - start,
  }

  notifyOpsEvent({
    flow: "giftcard",
    phase: "catalog-synced",
    status: "success",
    meta: {
      providerId,
      products: String(summary.products),
      countries: String(summary.countries),
      durationMs: String(summary.durationMs),
    },
  })

  return summary
}

type SyncLock = { acquired: false } | { acquired: true; release: () => Promise<void> }

const acquireSyncLock = async (): Promise<SyncLock | Error> => {
  try {
    const redis = await redisClient()
    const token = randomBytes(16).toString("hex")
    const set = await redis.set(
      GIFT_CARD_CATALOG_SYNC_LOCK_KEY,
      token,
      "EX",
      GIFT_CARD_CATALOG_SYNC_LOCK_TTL_SECONDS,
      "NX",
    )
    if (set !== "OK") return { acquired: false }

    const release = async () => {
      try {
        await redis.eval(RELEASE_IF_OWNER, 1, GIFT_CARD_CATALOG_SYNC_LOCK_KEY, token)
      } catch (err) {
        // The lock expires on its own; the next run is delayed by at most the TTL.
        baseLogger.warn({ err }, "gift card catalog sync lock release failed")
      }
    }
    return { acquired: true, release }
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err))
  }
}

// `true` when this run should proceed. Sets the marker atomically so two runs
// racing on the interval boundary cannot both pass.
const claimIntervalSlot = async (
  minIntervalSeconds: number,
): Promise<boolean | Error> => {
  try {
    const redis = await redisClient()
    const set = await redis.set(
      GIFT_CARD_CATALOG_SYNC_MARKER_KEY,
      new Date().toISOString(),
      "EX",
      minIntervalSeconds,
      "NX",
    )
    return set === "OK"
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err))
  }
}

// A run in which nothing synced must not hold the interval: the next cron tick
// should retry rather than wait out a full interval on a transient vendor fault.
const releaseIntervalSlot = async (): Promise<void> => {
  try {
    const redis = await redisClient()
    await redis.del(GIFT_CARD_CATALOG_SYNC_MARKER_KEY)
  } catch (err) {
    baseLogger.warn({ err }, "gift card catalog sync interval marker release failed")
  }
}

/**
 * Sync every enabled provider. Never throws; never lets one provider's failure
 * stop the others. Returns the summaries of the providers that synced.
 *
 * `minIntervalSeconds`, when set, skips the run entirely if a run completed
 * less than that long ago (Redis marker). The cron passes
 * `catalog.syncIntervalSeconds`; direct callers (an operator forcing a refresh)
 * leave it unset.
 */
const syncAll = async ({
  minIntervalSeconds,
}: { minIntervalSeconds?: number } = {}): Promise<GiftCardCatalogSyncSummary[]> => {
  try {
    const lock = await acquireSyncLock()
    if (lock instanceof Error) {
      baseLogger.warn({ err: lock }, "gift card catalog sync skipped: lock unavailable")
      return []
    }
    if (!lock.acquired) {
      baseLogger.info("gift card catalog sync skipped: another run holds the lock")
      return []
    }

    try {
      let claimedInterval = false
      if (minIntervalSeconds !== undefined && minIntervalSeconds > 0) {
        const claim = await claimIntervalSlot(minIntervalSeconds)
        if (claim instanceof Error) {
          baseLogger.warn(
            { err: claim },
            "gift card catalog sync skipped: interval marker unavailable",
          )
          return []
        }
        if (!claim) {
          baseLogger.info(
            { minIntervalSeconds },
            "gift card catalog sync skipped: synced within the interval",
          )
          return []
        }
        claimedInterval = true
      }

      const providers = enabledGiftCardProviders()
      const summaries: GiftCardCatalogSyncSummary[] = []
      for (const provider of providers) {
        const result = await syncForProvider(provider)
        if (result instanceof Error) continue
        summaries.push(result)
        baseLogger.info(result, "gift card catalog synced")
      }

      if (claimedInterval && providers.length > 0 && summaries.length === 0) {
        await releaseIntervalSlot()
      }

      return summaries
    } finally {
      await lock.release()
    }
  } catch (err) {
    baseLogger.error({ err }, "gift card catalog sync crashed")
    return []
  }
}

export const { syncGiftCardCatalogForProvider, syncGiftCardCatalogs } =
  wrapAsyncFunctionsToRunInSpan({
    namespace: "app.gift-cards",
    fns: {
      syncGiftCardCatalogForProvider: syncForProvider,
      syncGiftCardCatalogs: syncAll,
    },
  })
