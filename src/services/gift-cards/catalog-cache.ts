import { GiftCardsConfig } from "@config"

import { CacheUndefinedError } from "@domain/cache"
import { toSeconds } from "@domain/primitives"
import {
  GiftCardCatalogUnavailableError,
  GiftCardProductNotFoundError,
  normalizeCountryCode,
} from "@domain/gift-cards"
import { baseLogger } from "@services/logger"
import { wrapAsyncFunctionsToRunInSpan } from "@services/tracing"

// Loaded on first use rather than at import time. `@services/cache` constructs
// a Redis client as a module side effect; this module is imported by every
// gift card use-case, and eagerly importing it would drag a live Redis
// connection into each of their unit tests. Same posture as
// `@services/fygaro/checkout-intent-store`.
const cacheService = async () => (await import("@services/cache")).RedisCacheService()

/**
 * Redis-backed read model of each vendor's catalog.
 *
 * The sync job (`syncGiftCardCatalogs`) is the only writer; every request path
 * reads. Layout:
 *
 *   giftcards:catalog:<providerId>:<CC>       -> { syncedAt: ISO, products: GiftCardProduct[] }
 *   giftcards:catalog:<providerId>:countries  -> string[] (upper-case ISO 3166-1 alpha-2)
 *   giftcards:product:<productId>             -> GiftCardProduct
 *
 * Every key lives for `catalog.staleAfterSeconds`, NOT `catalog.ttlSeconds`.
 * The two are deliberately different: a catalog older than `ttlSeconds` is
 * served with `stale: true` so a vendor outage degrades to "slightly old
 * prices" instead of "no gift cards"; past `staleAfterSeconds` Redis drops the
 * key and the read becomes `GiftCardCatalogUnavailableError`. The countries
 * index is written last so a sync that dies half-way never advertises a
 * country whose catalog key was not written.
 */
export type CatalogRead = {
  products: GiftCardProduct[]
  syncedAt: Date
  stale: boolean
}

type StoredCatalog = {
  syncedAt: string
  products: GiftCardProduct[]
}

export const giftCardCatalogKey = (providerId: GiftCardProviderId, countryCode: string) =>
  `giftcards:catalog:${providerId}:${countryCode}`

export const giftCardCountriesKey = (providerId: GiftCardProviderId) =>
  `giftcards:catalog:${providerId}:countries`

export const giftCardProductKey = (productId: GiftCardProductId) =>
  `giftcards:product:${productId}`

const retentionSeconds = (): Seconds =>
  toSeconds(GiftCardsConfig.catalog.staleAfterSeconds)

const staleAfterMs = (): number => GiftCardsConfig.catalog.ttlSeconds * 1000

const isStoredCatalog = (value: unknown): value is StoredCatalog =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as StoredCatalog).syncedAt === "string" &&
  Array.isArray((value as StoredCatalog).products)

const parseSyncedAt = (raw: string): Date | null => {
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? null : date
}

export const GiftCardCatalogCache = () => {
  const write = async ({
    providerId,
    products,
    syncedAt,
  }: {
    providerId: GiftCardProviderId
    products: GiftCardProduct[]
    syncedAt: Date
  }): Promise<{ countries: string[] } | GiftCardCatalogUnavailableError> => {
    const cache = await cacheService()
    const ttlSecs = retentionSeconds()

    const byCountry = new Map<string, GiftCardProduct[]>()
    for (const product of products) {
      const cc = normalizeCountryCode(product.countryCode)
      const group = byCountry.get(cc)
      if (group) group.push(product)
      else byCountry.set(cc, [product])
    }
    const countries = [...byCountry.keys()].sort()

    for (const cc of countries) {
      const group = byCountry.get(cc) as GiftCardProduct[]
      const stored: StoredCatalog = { syncedAt: syncedAt.toISOString(), products: group }

      const catalogWrite = await cache.set<StoredCatalog>({
        key: giftCardCatalogKey(providerId, cc),
        value: stored,
        ttlSecs,
      })
      if (catalogWrite instanceof Error) {
        baseLogger.error(
          { providerId, countryCode: cc, err: catalogWrite },
          "gift card catalog write failed",
        )
        return new GiftCardCatalogUnavailableError(catalogWrite.message)
      }

      const productWrites = await Promise.all(
        group.map((product) =>
          cache.set<GiftCardProduct>({
            key: giftCardProductKey(product.id),
            value: product,
            ttlSecs,
          }),
        ),
      )
      const failed = productWrites.find(
        (res): res is CacheServiceError => res instanceof Error,
      )
      if (failed) {
        baseLogger.error(
          { providerId, countryCode: cc, err: failed },
          "gift card product write failed",
        )
        return new GiftCardCatalogUnavailableError(failed.message)
      }
    }

    // Last on purpose: see the module comment.
    const indexWrite = await cache.set<string[]>({
      key: giftCardCountriesKey(providerId),
      value: countries,
      ttlSecs,
    })
    if (indexWrite instanceof Error) {
      baseLogger.error(
        { providerId, err: indexWrite },
        "gift card countries index write failed",
      )
      return new GiftCardCatalogUnavailableError(indexWrite.message)
    }

    return { countries }
  }

  const read = async ({
    providerId,
    countryCode,
  }: {
    providerId: GiftCardProviderId
    countryCode: string
  }): Promise<CatalogRead | GiftCardCatalogUnavailableError> => {
    const cache = await cacheService()
    const cc = normalizeCountryCode(countryCode)

    const stored = await cache.get<unknown>({ key: giftCardCatalogKey(providerId, cc) })
    if (stored instanceof Error) {
      if (!(stored instanceof CacheUndefinedError)) {
        baseLogger.warn(
          { providerId, countryCode: cc, err: stored },
          "gift card catalog read failed",
        )
      }
      return new GiftCardCatalogUnavailableError()
    }

    if (!isStoredCatalog(stored)) {
      baseLogger.error(
        { providerId, countryCode: cc },
        "gift card catalog record has an unexpected shape",
      )
      return new GiftCardCatalogUnavailableError()
    }

    const syncedAt = parseSyncedAt(stored.syncedAt)
    if (!syncedAt) {
      baseLogger.error(
        { providerId, countryCode: cc, syncedAt: stored.syncedAt },
        "gift card catalog record has an unparseable syncedAt",
      )
      return new GiftCardCatalogUnavailableError()
    }

    return {
      products: stored.products,
      syncedAt,
      stale: Date.now() - syncedAt.getTime() > staleAfterMs(),
    }
  }

  const readProduct = async (
    productId: GiftCardProductId,
  ): Promise<
    GiftCardProduct | GiftCardProductNotFoundError | GiftCardCatalogUnavailableError
  > => {
    const cache = await cacheService()

    const stored = await cache.get<GiftCardProduct>({
      key: giftCardProductKey(productId),
    })
    if (stored instanceof CacheUndefinedError) return new GiftCardProductNotFoundError()
    if (stored instanceof Error) {
      baseLogger.warn({ productId, err: stored }, "gift card product read failed")
      return new GiftCardCatalogUnavailableError()
    }
    return stored
  }

  const countries = async (
    providerId: GiftCardProviderId,
  ): Promise<string[] | GiftCardCatalogUnavailableError> => {
    const cache = await cacheService()

    const stored = await cache.get<unknown>({ key: giftCardCountriesKey(providerId) })
    if (stored instanceof Error) {
      if (!(stored instanceof CacheUndefinedError)) {
        baseLogger.warn(
          { providerId, err: stored },
          "gift card countries index read failed",
        )
      }
      return new GiftCardCatalogUnavailableError()
    }
    if (!Array.isArray(stored) || !stored.every((cc) => typeof cc === "string")) {
      baseLogger.error(
        { providerId },
        "gift card countries index has an unexpected shape",
      )
      return new GiftCardCatalogUnavailableError()
    }
    return stored
  }

  return wrapAsyncFunctionsToRunInSpan({
    namespace: "services.gift-cards.catalog-cache",
    fns: { write, read, readProduct, countries },
  })
}
