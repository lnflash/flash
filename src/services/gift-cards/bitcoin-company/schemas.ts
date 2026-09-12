import { z } from "zod"

/**
 * Zod validators for Bitcoin Company responses. Every response is validated
 * before it is mapped; a shape mismatch becomes `GiftCardVendorUnavailableError`
 * at the client boundary rather than a thrown TypeError deep in mapping code.
 *
 * `z.object` strips unknown keys, which is what we want: vendor fields we do
 * not model never travel past the adapter (and never reach a log line).
 *
 * Strictness is deliberate per field: anything that decides money or state
 * (`invoice`, `uuid`, `fiatCost`, `satsCost`, `status`) is required; fields we
 * only display or log (`bitcoinPrice`, `satsBack`, `amount`, `orderId`) are
 * `nullish` so a vendor dropping one cannot stall a purchase.
 */

/** Numbers the vendor may serialise as strings. Rejects null/empty rather than coercing to 0. */
const numeric = z.union([
  z.number(),
  z
    .string()
    .trim()
    .regex(/^-?\d+(\.\d+)?$/)
    .transform(Number),
])

/**
 * `{ statusCode, result: T | null, error: string | null }` around every endpoint.
 * `result` is validated separately by the client against the per-endpoint
 * schema; keeping it `unknown` here sidesteps zod's generic-object inference
 * and lets the client tell "missing result" from "wrong-shaped result".
 */
export const envelopeSchema = z.object({
  statusCode: z.number().optional(),
  result: z.unknown(),
  error: z.string().nullable().optional(),
})

export const authTokensSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
})
export type VendorAuthTokens = z.infer<typeof authTokensSchema>

/** What we keep in Redis under `giftcards:auth:bitcoinCompany`. */
export const cachedTokensSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  accessExpiresAt: z.number().int(),
})
export type CachedTokens = z.infer<typeof cachedTokensSchema>

export const vendorProductSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullish(),
  countries: z.array(z.string()),
  currency: z.string().min(1),
  currencySymbol: z.string().nullish(),
  denominationType: z.string(),
  // Major units of `currency`.
  denominations: z.array(numeric),
  defaultDenoms: z.array(numeric).nullish(),
  isOpenLoop: z.boolean(),
  isPhysical: z.boolean().nullish(),
  categories: z.array(z.string()).nullish(),
  logo: z.string().nullish(),
  panelImg: z.string().nullish(),
  terms: z.string().nullish(),
  satsBackPercentage: numeric,
  stock: numeric,
  productType: z.string().nullish(),
  paymentTypes: z.array(z.string()).nullish(),
  resellingEnabled: z.boolean().nullish(),
  deliveryTypes: z.array(z.string()).nullish(),
})
export type VendorProduct = z.infer<typeof vendorProductSchema>

/**
 * One catalog page. Rows are kept as `unknown` and validated one at a time by
 * the client so a single malformed product is skipped instead of failing the
 * whole sync.
 */
export const catalogPageSchema = z.object({
  svs: z.array(z.unknown()),
})

export const quoteResultSchema = z.object({
  // Major units of the product currency.
  fiatCost: numeric,
  satsCost: numeric,
  // Reward is informational: absent or null reads as "no reward", never as a failed quote.
  satsBack: numeric.nullish().transform((value) => value ?? 0),
  // Informational; surfaced to the client as-is when present.
  bitcoinPrice: numeric.nullish(),
  quoteMode: z.string().nullish(),
  customerDiscountFiat: numeric.nullish(),
})
export type VendorQuote = z.infer<typeof quoteResultSchema>

export const purchaseResultSchema = z.object({
  invoice: z.string().min(1),
  address: z.string().nullish(),
  // Sats the vendor says the invoice is for. Informational: the BOLT11 itself
  // is decoded by the purchase path and its amount governs what we pay.
  amount: numeric.nullish(),
  // Vendor's human-facing order number; `uuid` is the key we store and query by.
  orderId: z.union([z.string(), z.number()]).nullish(),
  uuid: z.union([z.string(), z.number()]),
  satsBack: numeric.nullish(),
})
export type VendorPurchase = z.infer<typeof purchaseResultSchema>

export const claimDataSchema = z.object({
  codes: z
    .array(
      z.object({
        label: z.string().nullish(),
        value: z.string(),
      }),
    )
    .nullish(),
  claimLink: z.string().nullish(),
  barcodeChars: z.string().nullish(),
  barcodeType: z.string().nullish(),
})
export type VendorClaimData = z.infer<typeof claimDataSchema>

/**
 * Exactly one `{ status, claimData }`. No sandbox capture exists yet of what
 * `/giftcards/invoice-status` returns for an order of two or more cards (one
 * entry? an array?), which is why the adapter caps `maxQuantity` at 1: a
 * per-card array here would fail this schema on every status poll.
 */
export const purchasedProductSchema = z.object({
  status: z.string(),
  claimData: claimDataSchema.nullish(),
})
export type VendorPurchasedProduct = z.infer<typeof purchasedProductSchema>
