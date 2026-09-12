import { z } from "zod"

import { GiftCardsConfig } from "@config"

import { CacheUndefinedError } from "@domain/cache"
import { toSeconds } from "@domain/primitives"
import {
  GiftCardCatalogUnavailableError,
  GiftCardProductNotFoundError,
  isGiftCardProviderId,
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
 *   giftcards:products:<providerId>           -> GiftCardProductId[] written by the last sync
 *   giftcards:product:<productId>             -> GiftCardProduct
 *
 * Every key lives for `catalog.staleAfterSeconds`, NOT `catalog.ttlSeconds`.
 * The two are deliberately different: a catalog older than `ttlSeconds` is
 * served with `stale: true` so a vendor outage degrades to "slightly old
 * prices" instead of "no gift cards"; past `staleAfterSeconds` Redis drops the
 * key and the read becomes `GiftCardCatalogUnavailableError`. The countries
 * index is written last so a sync that dies half-way never advertises a
 * country whose catalog key was not written.
 *
 * The product-id set exists so a sync can delete the product keys of cards the
 * vendor delisted since the previous sync. Without it a delisted product stays
 * quotable for up to `staleAfterSeconds` and the vendor rejects the purchase.
 */
export type CatalogRead = {
  products: GiftCardProduct[]
  syncedAt: Date
  stale: boolean
}

type StoredCatalog = {
  syncedAt: string
  products: unknown[]
}

export const giftCardCatalogKey = (providerId: GiftCardProviderId, countryCode: string) =>
  `giftcards:catalog:${providerId}:${countryCode}`

export const giftCardCountriesKey = (providerId: GiftCardProviderId) =>
  `giftcards:catalog:${providerId}:countries`

export const giftCardProductIdsKey = (providerId: GiftCardProviderId) =>
  `giftcards:products:${providerId}`

export const giftCardProductKey = (productId: GiftCardProductId) =>
  `giftcards:product:${productId}`

const retentionSeconds = (): Seconds =>
  toSeconds(GiftCardsConfig.catalog.staleAfterSeconds)

const staleAfterMs = (): number => GiftCardsConfig.catalog.ttlSeconds * 1000

/**
 * Shape of a product as the sync wrote it. Validated on every read so a
 * half-written or hand-edited key can never reach a quote. `maxQuantity` and
 * `wholeUnitsOnly` arrived after the first catalogs were cached; they default
 * so a running cache stays usable across that deploy. The next sync writes
 * real values.
 */
const cachedProductSchema = z.object({
  id: z.string().min(1),
  providerId: z.string().refine(isGiftCardProviderId),
  providerProductId: z.string().min(1),
  name: z.string(),
  brand: z.string(),
  countryCode: z.string(),
  currency: z.string(),
  denominationType: z.enum(["fixed", "variable"]),
  denominations: z.array(z.number()),
  minValue: z.number().nullable(),
  maxValue: z.number().nullable(),
  isOpenLoop: z.boolean(),
  categories: z.array(z.string()),
  logoUrl: z.string().nullable(),
  termsUrl: z.string().nullable(),
  rewardBps: z.number(),
  inStock: z.boolean(),
  maxQuantity: z.number().int().min(1).default(1),
  wholeUnitsOnly: z.boolean().default(false),
})

const toCachedProduct = (value: unknown): GiftCardProduct | null => {
  const parsed = cachedProductSchema.safeParse(value)
  if (!parsed.success) return null
  return {
    ...parsed.data,
    id: parsed.data.id as GiftCardProductId,
    providerId: parsed.data.providerId as GiftCardProviderId,
  }
}

const isStoredCatalog = (value: unknown): value is StoredCatalog =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as StoredCatalog).syncedAt === "string" &&
  Array.isArray((value as StoredCatalog).products)

const parseSyncedAt = (raw: string): Date | null => {
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? null : date
}

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string")

export const GiftCardCatalogCache = () => {
  // Ids the previous sync wrote. Unreadable or missing reads as "none": the
  // diff then deletes nothing, and stale keys fall back to expiring on TTL.
  const previousProductIds = async (
    cache: ICacheService,
    providerId: GiftCardProviderId,
  ): Promise<string[]> => {
    const stored = await cache.get<unknown>({ key: giftCardProductIdsKey(providerId) })
    if (stored instanceof Error) {
      if (!(stored instanceof CacheUndefinedError)) {
        baseLogger.warn(
          { providerId, err: stored },
          "gift card product id set read failed; skipping stale-key cleanup",
        )
      }
      return []
    }
    if (!isStringList(stored)) {
      baseLogger.warn(
        { providerId },
        "gift card product id set has an unexpected shape; skipping stale-key cleanup",
      )
      return []
    }
    return stored
  }

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

    const previousIds = await previousProductIds(cache, providerId)

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
      const stored = { syncedAt: syncedAt.toISOString(), products: group }

      const catalogWrite = await cache.set({
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

    // Delisted since the previous sync: drop the product keys so they cannot be
    // quoted. Best effort — a miss here is bounded by the key TTL. Deleting
    // BEFORE rewriting the id set means a crash in between leaves the stale ids
    // listed, so the next sync retries them.
    const currentIds = new Set<string>(products.map((product) => product.id))
    const delisted = previousIds.filter((id) => !currentIds.has(id))
    for (const id of delisted) {
      const cleared = await cache.clear({
        key: giftCardProductKey(id as GiftCardProductId),
      })
      if (cleared instanceof Error) {
        baseLogger.warn(
          { providerId, productId: id, err: cleared },
          "gift card delisted product key delete failed; it will expire on its own",
        )
      }
    }
    if (delisted.length > 0) {
      baseLogger.info(
        { providerId, delisted: delisted.length },
        "gift card delisted product keys removed",
      )
    }

    const idsWrite = await cache.set<string[]>({
      key: giftCardProductIdsKey(providerId),
      value: [...currentIds].sort(),
      ttlSecs,
    })
    if (idsWrite instanceof Error) {
      baseLogger.error(
        { providerId, err: idsWrite },
        "gift card product id set write failed",
      )
      return new GiftCardCatalogUnavailableError(idsWrite.message)
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

    // Rows are validated one at a time: one bad row is dropped and counted,
    // not allowed to take the whole country's listing down with it.
    const products: GiftCardProduct[] = []
    let dropped = 0
    for (const row of stored.products) {
      const product = toCachedProduct(row)
      if (product) products.push(product)
      else dropped += 1
    }
    if (dropped > 0) {
      baseLogger.error(
        { providerId, countryCode: cc, dropped, kept: products.length },
        "gift card catalog record has rows of an unexpected shape; dropped",
      )
    }

    return {
      products,
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

    const stored = await cache.get<unknown>({ key: giftCardProductKey(productId) })
    if (stored instanceof CacheUndefinedError) return new GiftCardProductNotFoundError()
    if (stored instanceof Error) {
      baseLogger.warn({ productId, err: stored }, "gift card product read failed")
      return new GiftCardCatalogUnavailableError()
    }

    const product = toCachedProduct(stored)
    if (!product) {
      baseLogger.error({ productId }, "gift card product record has an unexpected shape")
      return new GiftCardProductNotFoundError()
    }
    return product
  }

  return wrapAsyncFunctionsToRunInSpan({
    namespace: "services.gift-cards.catalog-cache",
    fns: { write, read, readProduct },
  })
}
