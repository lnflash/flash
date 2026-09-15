import { GiftCardsConfig } from "@config"

import {
  decodeGiftCardProductCursor,
  encodeGiftCardProductCursor,
  GiftCardProductNotFoundError,
  normalizeCountryCode,
  parseGiftCardProductId,
} from "@domain/gift-cards"
import { notifyOpsEvent } from "@services/alerts/ops-events"
import { resolveGiftCardProviderIdForCountry } from "@services/gift-cards"
import { GiftCardCatalogCache } from "@services/gift-cards/catalog-cache"
import { wrapAsyncFunctionsToRunInSpan } from "@services/tracing"

/**
 * Catalog reads for the storefront. Served entirely from the Redis read model
 * the sync job maintains — no request here ever reaches a vendor.
 *
 * Flash policy lives here, not in the cache: out-of-stock rows are hidden,
 * open-loop (Visa/Mastercard-style) cards are hidden unless
 * `giftCards.allowOpenLoop` is on, and the same rule is applied to a direct
 * product lookup so a client cannot reach an open-loop card by id that the list
 * would never have shown it.
 */
export type GiftCardProductPage = {
  products: GiftCardProduct[]
  hasNextPage: boolean
  endCursor: string | null
  stale: boolean
}

export const GIFT_CARD_LIST_DEFAULT_FIRST = 50
export const GIFT_CARD_LIST_MAX_FIRST = 200

// A stale catalog is served, not refused — but someone should know. One embed
// per provider per window keeps a busy storefront on an aging catalog from
// posting once per request into the 50-deep ops queue (same shape as
// `OPS_EVENT_COALESCE_MS` in app/payments/authorize-send.ts).
export const GIFT_CARD_STALE_EVENT_COALESCE_MS = 10 * 60 * 1000

const staleEventWindows = new Map<GiftCardProviderId, number>()

// Test-only. The windows are per-process by design; without this one spec's
// stale event silences the next spec's.
export const __resetGiftCardStaleEventsForTest = (): void => {
  staleEventWindows.clear()
}

const notifyStaleCatalog = (
  providerId: GiftCardProviderId,
  countryCode: string,
): void => {
  const now = Date.now()
  const openedAt = staleEventWindows.get(providerId)
  if (openedAt !== undefined && now - openedAt < GIFT_CARD_STALE_EVENT_COALESCE_MS) return

  staleEventWindows.set(providerId, now)
  notifyOpsEvent({
    flow: "giftcard",
    phase: "catalog-stale",
    status: "pending",
    meta: { providerId, countryCode },
  })
}

const isOpenLoopAllowed = (): boolean => GiftCardsConfig.allowOpenLoop === true

const encodeCursor = encodeGiftCardProductCursor
const decodeCursor = decodeGiftCardProductCursor

const clampFirst = (first: number | undefined): number => {
  if (first === undefined || !Number.isFinite(first)) return GIFT_CARD_LIST_DEFAULT_FIRST
  const whole = Math.floor(first)
  if (whole < 1) return GIFT_CARD_LIST_DEFAULT_FIRST
  return Math.min(whole, GIFT_CARD_LIST_MAX_FIRST)
}

const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

// Brand, then name, then id. Case-insensitive on the human-facing fields so
// "amazon" and "Amazon" sit together; the id tiebreak makes the order total,
// which is what lets an id-based cursor resume in the right place.
const compareProducts = (a: GiftCardProduct, b: GiftCardProduct): number =>
  compareStrings(a.brand.toLowerCase(), b.brand.toLowerCase()) ||
  compareStrings(a.name.toLowerCase(), b.name.toLowerCase()) ||
  compareStrings(a.id, b.id)

const matchesCategory = (product: GiftCardProduct, category: string): boolean => {
  const wanted = category.trim().toLowerCase()
  return product.categories.some((c) => c.toLowerCase() === wanted)
}

const matchesSearch = (product: GiftCardProduct, search: string): boolean => {
  const needle = search.trim().toLowerCase()
  return (
    product.name.toLowerCase().includes(needle) ||
    product.brand.toLowerCase().includes(needle)
  )
}

const listProducts = async ({
  countryCode,
  category,
  search,
  first,
  after,
}: {
  countryCode: string
  category?: string
  search?: string
  first?: number
  after?: string
}): Promise<GiftCardProductPage | ApplicationError> => {
  const cc = normalizeCountryCode(countryCode)

  const providerId = resolveGiftCardProviderIdForCountry(cc)
  if (providerId instanceof Error) return providerId

  const catalog = await GiftCardCatalogCache().read({ providerId, countryCode: cc })
  if (catalog instanceof Error) return catalog

  if (catalog.stale) notifyStaleCatalog(providerId, cc)

  const allowOpenLoop = isOpenLoopAllowed()
  const wantedCategory = category?.trim() ? category : undefined
  const wantedSearch = search?.trim() ? search : undefined

  const matching = catalog.products
    .filter((p) => p.inStock)
    .filter((p) => allowOpenLoop || !p.isOpenLoop)
    .filter((p) => wantedCategory === undefined || matchesCategory(p, wantedCategory))
    .filter((p) => wantedSearch === undefined || matchesSearch(p, wantedSearch))
    .sort(compareProducts)

  // A cursor names the last id the client saw. If that product has since left
  // the catalog (resync dropped it, or it went out of stock), we cannot place it
  // and start over rather than guess — the client may see a repeat, never a gap.
  let start = 0
  if (after) {
    const afterId = decodeCursor(after)
    const idx = matching.findIndex((p) => p.id === afterId)
    if (idx >= 0) start = idx + 1
  }

  const limit = clampFirst(first)
  const page = matching.slice(start, start + limit)
  const last = page[page.length - 1]

  return {
    products: page,
    hasNextPage: start + limit < matching.length,
    endCursor: last ? encodeCursor(last.id) : null,
    stale: catalog.stale,
  }
}

const getProduct = async (
  productId: GiftCardProductId,
): Promise<GiftCardProduct | ApplicationError> => {
  const parsed = parseGiftCardProductId(productId)
  if (parsed instanceof Error) return parsed

  const product = await GiftCardCatalogCache().readProduct(productId)
  if (product instanceof Error) return product

  // Same answer as "never existed": admitting the card exists but is withheld
  // tells a client which ids to try once the flag flips.
  if (product.isOpenLoop && !isOpenLoopAllowed())
    return new GiftCardProductNotFoundError()

  return product
}

export const { listGiftCardProducts, getGiftCardProduct } = wrapAsyncFunctionsToRunInSpan(
  {
    namespace: "app.gift-cards",
    fns: { listGiftCardProducts: listProducts, getGiftCardProduct: getProduct },
  },
)
