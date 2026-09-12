/**
 * Shared fixtures for the Bitcoin Company adapter specs. Vendor payloads here
 * follow the shapes documented in ENG-577; anything the vendor has not
 * confirmed is flagged in the adapter's report, not here.
 */

export const NOW = Date.parse("2026-09-09T12:00:00Z")
export const BASE_URL = "https://api.dev.thebitcoincompany.com"

export const bitcoinCompanyConfigFixture = {
  enabled: true,
  baseUrl: BASE_URL,
  email: "ops@example.com",
  password: "hunter2-not-a-real-password",
  referralCode: "",
  timeoutMs: 5000,
}

export const giftCardsConfigFixture = {
  enabled: true,
  allowOpenLoop: false,
  feeBps: 0,
  claimDataEncryptionKey: "",
  quoteToleranceBps: 100,
  routing: { default: "bitcoinCompany", byCountry: {} },
  providers: {
    bitcoinCompany: bitcoinCompanyConfigFixture,
    bitrefill: {
      enabled: false,
      baseUrl: "",
      apiId: "",
      apiSecret: "",
      webhookSecret: "",
      timeoutMs: 5000,
    },
  },
}

// ============ Vendor payloads ============

export type VendorProductJson = {
  id: string
  name: string
  description?: string | null
  countries: string[]
  currency: string
  currencySymbol?: string | null
  denominationType: string
  denominations: number[]
  defaultDenoms?: number[] | null
  isOpenLoop: boolean
  isPhysical?: boolean
  categories?: string[]
  logo?: string | null
  panelImg?: string | null
  terms?: string | null
  satsBackPercentage: number
  stock: number
  productType?: string
  paymentTypes?: string[]
  resellingEnabled?: boolean
  deliveryTypes?: string[]
}

export const vendorProductFixture = (
  overrides: Partial<VendorProductJson> = {},
): VendorProductJson => ({
  id: "prod-amazon-us",
  name: "Amazon 🇺🇸 (US)",
  description: "Shop everything.",
  countries: ["US"],
  currency: "USD",
  currencySymbol: "$",
  denominationType: "Fixed",
  denominations: [10, 25, 50],
  defaultDenoms: [25],
  isOpenLoop: false,
  isPhysical: false,
  categories: ["Shopping"],
  logo: "https://cdn.example/amazon.png",
  panelImg: null,
  terms: "Terms and conditions apply.",
  satsBackPercentage: 1.5,
  stock: -1,
  productType: "svs",
  paymentTypes: ["Lightning"],
  resellingEnabled: true,
  deliveryTypes: ["Digital"],
  ...overrides,
})

export const vendorVariableProductFixture = (
  overrides: Partial<VendorProductJson> = {},
): VendorProductJson =>
  vendorProductFixture({
    id: "prod-visa-us",
    name: "Visa 🇺🇸 (US)",
    denominationType: "Variable",
    denominations: [5, 500],
    defaultDenoms: [50],
    isOpenLoop: true,
    categories: ["Prepaid"],
    satsBackPercentage: 0.5,
    ...overrides,
  })

export const makeCatalog = (count: number, offset = 0): VendorProductJson[] =>
  Array.from({ length: count }, (_, i) =>
    vendorProductFixture({
      id: `prod-${offset + i}`,
      name: `Brand ${offset + i} 🇺🇸 (US)`,
    }),
  )

export const ACCESS_TOKEN_1 = "access-token-one-SECRET"
export const REFRESH_TOKEN_1 = "refresh-token-one-SECRET"
export const ACCESS_TOKEN_2 = "access-token-two-SECRET"
export const REFRESH_TOKEN_2 = "refresh-token-two-SECRET"
export const CLAIM_CODE = "CLAIM-CODE-1234-SECRET"
export const CLAIM_LINK = "https://claim.example/redeem/abc-SECRET"

export const SECRET_STRINGS = [
  ACCESS_TOKEN_1,
  REFRESH_TOKEN_1,
  ACCESS_TOKEN_2,
  REFRESH_TOKEN_2,
  CLAIM_CODE,
  CLAIM_LINK,
  bitcoinCompanyConfigFixture.password,
]

export const LOGIN_RESULT = {
  accessToken: ACCESS_TOKEN_1,
  refreshToken: REFRESH_TOKEN_1,
  user: { id: "user-1", email: "ops@example.com" },
}

export const REFRESH_RESULT = {
  accessToken: ACCESS_TOKEN_2,
  refreshToken: REFRESH_TOKEN_2,
}

export const QUOTE_RESULT = {
  fiatCost: 25,
  satsCost: 39000,
  satsBack: 585,
  bitcoinPrice: 64102.56,
  quoteMode: "standard",
}

export const INVOICE = "lnbc390u1pexampleinvoiceSECRETLOOKING"

export const PURCHASE_RESULT = {
  invoice: INVOICE,
  address: null,
  amount: 39000,
  orderId: 1234,
  uuid: "9f1c2b3a-0000-4000-8000-000000000001",
  satsBack: 585,
}

export const FULFILLED_RESULT = {
  status: "Completed",
  claimData: {
    codes: [{ label: "Claim code", value: CLAIM_CODE }],
    claimLink: CLAIM_LINK,
    barcodeChars: null,
    barcodeType: null,
  },
}

// ============ HTTP response builders (axios response shape) ============

export type AxiosLikeResponse = { status: number; data: unknown }

export const envelope = <T>(result: T, statusCode = 200) => ({
  statusCode,
  result,
  error: null,
})

export const httpOk = <T>(result: T): AxiosLikeResponse => ({
  status: 200,
  data: envelope(result),
})

export const httpError = (status: number, error: string): AxiosLikeResponse => ({
  status,
  data: { statusCode: status, result: null, error },
})

export const catalogPage = (products: unknown[]): AxiosLikeResponse =>
  httpOk({ svs: products })

/** What axios rejects with when no response arrived. */
export const networkError = (code = "ECONNRESET") =>
  Object.assign(new Error(`network: ${code}`), { isAxiosError: true, code })

// ============ Route-based mock helpers ============

export type RouteContext = {
  url: string
  path: string
  query: URLSearchParams
  body: unknown
  config: { headers?: Record<string, string>; timeout?: number }
}

export type RouteHandler = (
  ctx: RouteContext,
) => AxiosLikeResponse | Promise<AxiosLikeResponse>

export const pathOf = (url: string): string => {
  const parsed = new URL(url)
  return parsed.pathname
}

const dispatch = (routes: Record<string, RouteHandler>, ctx: RouteContext) => {
  const handler = routes[ctx.path]
  if (!handler) throw new Error(`unmocked route ${ctx.path}`)
  return handler(ctx)
}

/** `axios.get(url, config)` implementation that dispatches on the URL path. */
export const routeGet =
  (routes: Record<string, RouteHandler>) =>
  (url: string, config: RouteContext["config"] = {}) =>
    dispatch(routes, {
      url,
      path: pathOf(url),
      query: new URL(url).searchParams,
      body: undefined,
      config,
    })

/** `axios.post(url, body, config)` implementation that dispatches on the URL path. */
export const routePost =
  (routes: Record<string, RouteHandler>) =>
  (url: string, body: unknown, config: RouteContext["config"] = {}) =>
    dispatch(routes, {
      url,
      path: pathOf(url),
      query: new URL(url).searchParams,
      body,
      config,
    })

/** Calls a jest mock received for the given path, oldest first. */
export const callsTo = (mock: jest.Mock, path: string) =>
  mock.mock.calls.filter(([url]) => pathOf(url as string) === path)

export const bearerOf = (config: RouteContext["config"] | undefined) =>
  config?.headers?.Authorization ?? null

/** A handler that answers from a queue, then repeats the last entry. */
export const sequence = (...responses: AxiosLikeResponse[]): RouteHandler => {
  const queue = [...responses]
  return () => {
    const next = queue.length > 1 ? queue.shift() : queue[0]
    if (!next) throw new Error("sequence exhausted")
    return next
  }
}

/** A handler that rejects N times then answers. */
export const failThen = (failures: Error[], then: AxiosLikeResponse): RouteHandler => {
  const queue = [...failures]
  return async () => {
    const failure = queue.shift()
    if (failure) throw failure
    return then
  }
}

// ============ Catalog paging helpers ============

/**
 * A `/giftcards` handler that serves `rows` by `offset`/`size` the way a real
 * offset-paginated endpoint does, and an empty page past the end.
 * `maxPageSize` emulates a vendor that clamps `size` regardless of the request.
 */
export const pagedCatalog =
  (rows: unknown[], opts: { maxPageSize?: number } = {}): RouteHandler =>
  (ctx) => {
    const offset = Number(ctx.query.get("offset") ?? 0)
    const requested = Number(ctx.query.get("size") ?? rows.length)
    const size = opts.maxPageSize ? Math.min(requested, opts.maxPageSize) : requested
    return catalogPage(rows.slice(offset, offset + size))
  }

/** The `offset` query param of every `/giftcards` request, oldest first. */
export const catalogOffsets = (mock: jest.Mock): string[] =>
  callsTo(mock, "/giftcards").map(
    ([url]) => new URL(url as string).searchParams.get("offset") ?? "",
  )

// ============ Quantity-aware vendor routes ============

/** `quantity` from a quote/purchase request body; 1 when the body carries none. */
export const quantityOf = (body: unknown): number => {
  if (!body || typeof body !== "object") return 1
  const { quantity } = body as { quantity?: unknown }
  return typeof quantity === "number" && quantity >= 1 ? quantity : 1
}

/** `QUOTE_RESULT` for `quantity` cards: per-card money and sats scaled by the count. */
export const quoteResultFor = (quantity: number) => ({
  ...QUOTE_RESULT,
  fiatCost: QUOTE_RESULT.fiatCost * quantity,
  satsCost: QUOTE_RESULT.satsCost * quantity,
  satsBack: QUOTE_RESULT.satsBack * quantity,
})

/** `PURCHASE_RESULT` for `quantity` cards. */
export const purchaseResultFor = (quantity: number) => ({
  ...PURCHASE_RESULT,
  amount: PURCHASE_RESULT.amount * quantity,
  satsBack: PURCHASE_RESULT.satsBack * quantity,
})

/**
 * `/svs/quote-card` and `/giftcards/purchase/bitcoin` handlers that price by
 * the requested quantity, so a test asserting "the price of one" fails if the
 * adapter ever sends more than one.
 *
 * There is deliberately NO multi-card `/giftcards/invoice-status` fixture: the
 * sandbox response for a quantity-2 order has not been captured (one entry? a
 * per-card array?), and the adapter caps `maxQuantity` at 1 until it is.
 */
export const quoteCardRoute: RouteHandler = (ctx) =>
  httpOk(quoteResultFor(quantityOf(ctx.body)))

export const purchaseRoute: RouteHandler = (ctx) =>
  httpOk(purchaseResultFor(quantityOf(ctx.body)))
