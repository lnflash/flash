const mockRedisStore = new Map<string, string>()

jest.mock("axios", () => ({
  get: jest.fn(),
  post: jest.fn(),
  isAxiosError: jest.fn((err) => Boolean(err?.isAxiosError)),
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

jest.mock("@services/tracing", () => ({
  addAttributesToCurrentSpan: jest.fn(),
  recordExceptionInCurrentSpan: jest.fn(),
  wrapAsyncFunctionsToRunInSpan: ({ fns }: { fns: unknown }) => fns,
}))

jest.mock("@config", () => ({
  GiftCardsConfig: jest.requireActual("./fixtures").giftCardsConfigFixture,
}))

// In-memory stand-in for the real ioredis client, honouring the subset the
// token store uses: GET, SET [PX ttl] [NX], DEL, and the compare-and-delete EVAL.
jest.mock("@services/redis", () => ({
  redis: {
    get: async (key: string) => mockRedisStore.get(key) ?? null,
    set: async (key: string, value: string, ...opts: unknown[]) => {
      if (opts.includes("NX") && mockRedisStore.has(key)) return null
      mockRedisStore.set(key, value)
      return "OK"
    },
    del: async (key: string) => (mockRedisStore.delete(key) ? 1 : 0),
    eval: async (_script: string, _numKeys: number, key: string, nonce: string) => {
      if (mockRedisStore.get(key) === nonce) {
        mockRedisStore.delete(key)
        return 1
      }
      return 0
    },
  },
}))

import axios from "axios"

import {
  GiftCardVendorRejectedOrderError,
  GiftCardVendorUnavailableError,
} from "@domain/gift-cards"
import {
  BITCOIN_COMPANY_AUTH_CACHE_KEY,
  BITCOIN_COMPANY_AUTH_LOCK_KEY,
  BitcoinCompanyClient,
  BitcoinCompanyClientDeps,
  CATALOG_PAGE_SIZE,
  RETRY_MAX,
  redactForLog,
} from "@services/gift-cards/bitcoin-company/client"
import { baseLogger } from "@services/logger"
import { recordExceptionInCurrentSpan } from "@services/tracing"

import {
  ACCESS_TOKEN_1,
  ACCESS_TOKEN_2,
  CLAIM_CODE,
  CLAIM_LINK,
  FULFILLED_RESULT,
  INVOICE,
  LOGIN_RESULT,
  NOW,
  PURCHASE_RESULT,
  QUOTE_RESULT,
  REFRESH_RESULT,
  REFRESH_TOKEN_1,
  SECRET_STRINGS,
  bearerOf,
  bitcoinCompanyConfigFixture,
  callsTo,
  catalogPage,
  failThen,
  httpError,
  httpOk,
  makeCatalog,
  networkError,
  routeGet,
  routePost,
  sequence,
  vendorProductFixture,
} from "./fixtures"

const mockedAxios = axios as unknown as { get: jest.Mock; post: jest.Mock }
const mockedLogger = baseLogger as unknown as Record<
  "info" | "warn" | "error" | "debug",
  jest.Mock
>
const mockedRecordException = recordExceptionInCurrentSpan as jest.Mock

const ONE_MINUTE = 60 * 1000
const ONE_HOUR = 60 * ONE_MINUTE

const noSleep = () => Promise.resolve()

const makeClient = (overrides: BitcoinCompanyClientDeps = {}) =>
  new BitcoinCompanyClient({
    sleep: noSleep,
    now: () => NOW,
    random: () => 0,
    ...overrides,
  })

type Tokens = { accessToken: string; refreshToken: string; accessExpiresAt: number }

const seedTokens = (tokens: Tokens) =>
  mockRedisStore.set(BITCOIN_COMPANY_AUTH_CACHE_KEY, JSON.stringify(tokens))

const cachedTokens = (): Tokens | null => {
  const raw = mockRedisStore.get(BITCOIN_COMPANY_AUTH_CACHE_KEY)
  return raw ? JSON.parse(raw) : null
}

const FRESH_TOKENS: Tokens = {
  accessToken: ACCESS_TOKEN_1,
  refreshToken: REFRESH_TOKEN_1,
  accessExpiresAt: NOW + ONE_HOUR,
}

const STALE_TOKENS: Tokens = {
  accessToken: "stale-access-token",
  refreshToken: REFRESH_TOKEN_1,
  accessExpiresAt: NOW + 4 * ONE_MINUTE,
}

const QUOTE_ARGS = { productId: "prod-amazon-us", cardValue: 25, quantity: 1 }
const PURCHASE_ARGS = { ...QUOTE_ARGS, label: "gco_0001" }

const loginRoute = { "/auth/login": () => httpOk(LOGIN_RESULT) }
const quoteRoute = { "/svs/quote-card": () => httpOk(QUOTE_RESULT) }
const refreshRoute = { "/auth/refresh-token": () => httpOk(REFRESH_RESULT) }

beforeEach(() => {
  jest.clearAllMocks()
  mockedAxios.get.mockReset()
  mockedAxios.post.mockReset()
  mockRedisStore.clear()
})

describe("BitcoinCompanyClient auth", () => {
  it("logs in once and caches the token pair in Redis", async () => {
    mockedAxios.post.mockImplementation(routePost({ ...loginRoute, ...quoteRoute }))
    const client = makeClient()

    const first = await client.quoteCard(QUOTE_ARGS)
    const second = await client.quoteCard(QUOTE_ARGS)

    expect(first).toEqual(QUOTE_RESULT)
    expect(second).toEqual(QUOTE_RESULT)

    const logins = callsTo(mockedAxios.post, "/auth/login")
    expect(logins).toHaveLength(1)
    expect(logins[0][1]).toEqual({
      email: bitcoinCompanyConfigFixture.email,
      password: bitcoinCompanyConfigFixture.password,
    })
    expect(bearerOf(logins[0][2])).toBeNull()

    expect(cachedTokens()).toEqual({
      accessToken: ACCESS_TOKEN_1,
      refreshToken: REFRESH_TOKEN_1,
      accessExpiresAt: NOW + ONE_HOUR,
    })

    const quotes = callsTo(mockedAxios.post, "/svs/quote-card")
    expect(quotes).toHaveLength(2)
    expect(quotes.map((call) => bearerOf(call[2]))).toEqual([
      `Bearer ${ACCESS_TOKEN_1}`,
      `Bearer ${ACCESS_TOKEN_1}`,
    ])
    expect(mockRedisStore.has(BITCOIN_COMPANY_AUTH_LOCK_KEY)).toBe(false)
  })

  it("uses a cached access token without touching the auth endpoints", async () => {
    seedTokens(FRESH_TOKENS)
    mockedAxios.post.mockImplementation(routePost(quoteRoute))

    await makeClient().quoteCard(QUOTE_ARGS)

    expect(mockedAxios.get).not.toHaveBeenCalled()
    expect(callsTo(mockedAxios.post, "/auth/login")).toHaveLength(0)
    expect(bearerOf(callsTo(mockedAxios.post, "/svs/quote-card")[0][2])).toBe(
      `Bearer ${ACCESS_TOKEN_1}`,
    )
  })

  it("refreshes when the cached access token has under five minutes left", async () => {
    seedTokens(STALE_TOKENS)
    mockedAxios.get.mockImplementation(routeGet(refreshRoute))
    mockedAxios.post.mockImplementation(routePost(quoteRoute))

    const result = await makeClient().quoteCard(QUOTE_ARGS)

    expect(result).toEqual(QUOTE_RESULT)
    const refreshes = callsTo(mockedAxios.get, "/auth/refresh-token")
    expect(refreshes).toHaveLength(1)
    expect(bearerOf(refreshes[0][1])).toBe(`Bearer ${REFRESH_TOKEN_1}`)
    expect(callsTo(mockedAxios.post, "/auth/login")).toHaveLength(0)
    expect(bearerOf(callsTo(mockedAxios.post, "/svs/quote-card")[0][2])).toBe(
      `Bearer ${ACCESS_TOKEN_2}`,
    )
    expect(cachedTokens()).toEqual({
      accessToken: REFRESH_RESULT.accessToken,
      refreshToken: REFRESH_RESULT.refreshToken,
      accessExpiresAt: NOW + ONE_HOUR,
    })
  })

  it("on a 401 refreshes once and retries the call once", async () => {
    seedTokens(FRESH_TOKENS)
    mockedAxios.get.mockImplementation(routeGet(refreshRoute))
    mockedAxios.post.mockImplementation(
      routePost({
        "/svs/quote-card": sequence(httpError(401, "Unauthorized"), httpOk(QUOTE_RESULT)),
      }),
    )

    const result = await makeClient().quoteCard(QUOTE_ARGS)

    expect(result).toEqual(QUOTE_RESULT)
    const quotes = callsTo(mockedAxios.post, "/svs/quote-card")
    expect(quotes).toHaveLength(2)
    expect(quotes.map((call) => bearerOf(call[2]))).toEqual([
      `Bearer ${ACCESS_TOKEN_1}`,
      `Bearer ${ACCESS_TOKEN_2}`,
    ])
    expect(callsTo(mockedAxios.get, "/auth/refresh-token")).toHaveLength(1)
    expect(callsTo(mockedAxios.post, "/auth/login")).toHaveLength(0)
  })

  it("does not retry a second 401 after refreshing", async () => {
    seedTokens(FRESH_TOKENS)
    mockedAxios.get.mockImplementation(routeGet(refreshRoute))
    mockedAxios.post.mockImplementation(
      routePost({ "/svs/quote-card": () => httpError(401, "Unauthorized") }),
    )

    const result = await makeClient().quoteCard(QUOTE_ARGS)

    expect(result).toBeInstanceOf(GiftCardVendorUnavailableError)
    expect(callsTo(mockedAxios.post, "/svs/quote-card")).toHaveLength(2)
    expect(callsTo(mockedAxios.get, "/auth/refresh-token")).toHaveLength(1)
  })

  it("falls back to login when the refresh token is rejected", async () => {
    seedTokens(STALE_TOKENS)
    mockedAxios.get.mockImplementation(
      routeGet({ "/auth/refresh-token": () => httpError(401, "refresh token expired") }),
    )
    mockedAxios.post.mockImplementation(routePost({ ...loginRoute, ...quoteRoute }))

    const result = await makeClient().quoteCard(QUOTE_ARGS)

    expect(result).toEqual(QUOTE_RESULT)
    expect(callsTo(mockedAxios.get, "/auth/refresh-token")).toHaveLength(1)
    expect(callsTo(mockedAxios.post, "/auth/login")).toHaveLength(1)
    expect(bearerOf(callsTo(mockedAxios.post, "/svs/quote-card")[0][2])).toBe(
      `Bearer ${ACCESS_TOKEN_1}`,
    )
    expect(cachedTokens()).toEqual({
      accessToken: ACCESS_TOKEN_1,
      refreshToken: REFRESH_TOKEN_1,
      accessExpiresAt: NOW + ONE_HOUR,
    })
  })

  it("falls back to login when the refresh call fails on the network", async () => {
    seedTokens(STALE_TOKENS)
    mockedAxios.get.mockRejectedValue(networkError("ETIMEDOUT"))
    mockedAxios.post.mockImplementation(routePost({ ...loginRoute, ...quoteRoute }))

    const result = await makeClient().quoteCard(QUOTE_ARGS)

    expect(result).toEqual(QUOTE_RESULT)
    // Refresh is never retried: a rotated refresh token makes a replay harmful.
    expect(callsTo(mockedAxios.get, "/auth/refresh-token")).toHaveLength(1)
    expect(callsTo(mockedAxios.post, "/auth/login")).toHaveLength(1)
  })

  it("returns vendor-unavailable and caches nothing when login is rejected", async () => {
    mockedAxios.post.mockImplementation(
      routePost({ "/auth/login": () => httpError(401, "Invalid credentials") }),
    )

    const result = await makeClient().quoteCard(QUOTE_ARGS)

    expect(result).toBeInstanceOf(GiftCardVendorUnavailableError)
    expect(callsTo(mockedAxios.post, "/auth/login")).toHaveLength(1)
    expect(callsTo(mockedAxios.post, "/svs/quote-card")).toHaveLength(0)
    expect(cachedTokens()).toBeNull()
    expect(mockRedisStore.has(BITCOIN_COMPANY_AUTH_LOCK_KEY)).toBe(false)
  })

  it("refuses to call the vendor when credentials are not configured", async () => {
    mockedAxios.post.mockImplementation(routePost({ ...loginRoute, ...quoteRoute }))
    const client = makeClient({
      getConfig: () => ({ ...bitcoinCompanyConfigFixture, email: "", password: "" }),
    })

    const result = await client.quoteCard(QUOTE_ARGS)

    expect(result).toBeInstanceOf(GiftCardVendorUnavailableError)
    expect(mockedAxios.post).not.toHaveBeenCalled()
  })

  it("serialises concurrent token acquisition through the Redis lock", async () => {
    mockedAxios.post.mockImplementation(routePost({ ...loginRoute, ...quoteRoute }))
    // A real yield, so the waiter sees the holder finish before polling again.
    const client = makeClient({
      sleep: () => new Promise((resolve) => setImmediate(resolve)),
    })

    const results = await Promise.all([
      client.quoteCard(QUOTE_ARGS),
      client.quoteCard(QUOTE_ARGS),
      client.quoteCard(QUOTE_ARGS),
    ])

    expect(results).toEqual([QUOTE_RESULT, QUOTE_RESULT, QUOTE_RESULT])
    expect(callsTo(mockedAxios.post, "/auth/login")).toHaveLength(1)
    expect(mockRedisStore.has(BITCOIN_COMPANY_AUTH_LOCK_KEY)).toBe(false)
  })

  it("still works when Redis is unavailable, by logging in each time", async () => {
    mockedAxios.post.mockImplementation(routePost({ ...loginRoute, ...quoteRoute }))
    const failing = async () => {
      throw new Error("ECONNREFUSED redis")
    }
    const client = makeClient({
      tokenStore: { read: failing, write: failing, clear: failing, tryLock: failing },
    })

    const result = await client.quoteCard(QUOTE_ARGS)

    expect(result).toEqual(QUOTE_RESULT)
    expect(callsTo(mockedAxios.post, "/auth/login")).toHaveLength(1)
  })
})

describe("BitcoinCompanyClient catalog", () => {
  it("pages through the catalog until a short page (500 + 355 = 855)", async () => {
    mockedAxios.get.mockImplementation(
      routeGet({
        "/giftcards": (ctx) => {
          const offset = Number(ctx.query.get("offset"))
          return catalogPage(
            offset === 0 ? makeCatalog(CATALOG_PAGE_SIZE, 0) : makeCatalog(355, offset),
          )
        },
      }),
    )

    const result = await makeClient().listProducts()

    if (result instanceof Error) throw result
    expect(result).toHaveLength(855)
    expect(new Set(result.map((p) => p.id)).size).toBe(855)

    const pages = callsTo(mockedAxios.get, "/giftcards")
    expect(pages).toHaveLength(2)
    expect(pages.map(([url]) => new URL(url).searchParams.get("offset"))).toEqual([
      "0",
      "500",
    ])
    expect(pages.map(([url]) => new URL(url).searchParams.get("size"))).toEqual([
      "500",
      "500",
    ])
    // Public endpoint: no auth round-trip.
    expect(bearerOf(pages[0][1])).toBeNull()
    expect(mockedAxios.post).not.toHaveBeenCalled()
  })

  it("stops after a full page followed by an empty one", async () => {
    mockedAxios.get.mockImplementation(
      routeGet({
        "/giftcards": (ctx) =>
          catalogPage(
            Number(ctx.query.get("offset")) === 0 ? makeCatalog(CATALOG_PAGE_SIZE) : [],
          ),
      }),
    )

    const result = await makeClient().listProducts()

    if (result instanceof Error) throw result
    expect(result).toHaveLength(CATALOG_PAGE_SIZE)
    expect(callsTo(mockedAxios.get, "/giftcards")).toHaveLength(2)
  })

  it("skips catalog rows that fail validation instead of failing the sync", async () => {
    mockedAxios.get.mockImplementation(
      routeGet({
        "/giftcards": () =>
          catalogPage([
            vendorProductFixture(),
            { id: 42, name: "broken" },
            vendorProductFixture({
              id: "prod-2",
              isOpenLoop: "yes" as unknown as boolean,
            }),
          ]),
      }),
    )

    const result = await makeClient().listProducts()

    if (result instanceof Error) throw result
    expect(result.map((p) => p.id)).toEqual(["prod-amazon-us"])
    expect(mockedLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ op: "listProducts", skipped: 2, kept: 1 }),
      expect.any(String),
    )
  })

  it("retries a GET after a network error and then succeeds", async () => {
    mockedAxios.get.mockImplementation(
      routeGet({
        "/giftcards": failThen(
          [networkError("ECONNRESET")],
          catalogPage([vendorProductFixture()]),
        ),
      }),
    )

    const result = await makeClient().listProducts()

    if (result instanceof Error) throw result
    expect(result).toHaveLength(1)
    expect(callsTo(mockedAxios.get, "/giftcards")).toHaveLength(2)
    expect(mockedLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ op: "listProducts", attempt: 1 }),
      expect.any(String),
    )
  })

  it("gives up after the retry budget on a persistent 5xx", async () => {
    mockedAxios.get.mockImplementation(
      routeGet({ "/giftcards": () => httpError(503, "Service Unavailable") }),
    )

    const result = await makeClient().listProducts()

    expect(result).toBeInstanceOf(GiftCardVendorUnavailableError)
    expect(callsTo(mockedAxios.get, "/giftcards")).toHaveLength(RETRY_MAX + 1)
  })

  it("does not retry a 4xx on a GET", async () => {
    mockedAxios.get.mockImplementation(
      routeGet({ "/giftcards": () => httpError(400, "Bad Request") }),
    )

    const result = await makeClient().listProducts()

    expect(result).toBeInstanceOf(GiftCardVendorUnavailableError)
    expect(callsTo(mockedAxios.get, "/giftcards")).toHaveLength(1)
  })
})

describe("BitcoinCompanyClient purchase", () => {
  beforeEach(() => seedTokens(FRESH_TOKENS))

  it("sends the documented purchase body and returns the validated result", async () => {
    mockedAxios.post.mockImplementation(
      routePost({ "/giftcards/purchase/bitcoin": () => httpOk(PURCHASE_RESULT) }),
    )

    const result = await makeClient().purchase(PURCHASE_ARGS)

    expect(result).toEqual(PURCHASE_RESULT)
    const [, body] = callsTo(mockedAxios.post, "/giftcards/purchase/bitcoin")[0]
    expect(body).toEqual({
      productId: "prod-amazon-us",
      cardValue: 25,
      quantity: 1,
      useUsdBalance: false,
      useSatsBalance: false,
      label: "gco_0001",
    })
  })

  it("never retries a purchase on a 5xx", async () => {
    mockedAxios.post.mockImplementation(
      routePost({
        "/giftcards/purchase/bitcoin": () => httpError(500, "Internal Server Error"),
      }),
    )

    const result = await makeClient().purchase(PURCHASE_ARGS)

    expect(result).toBeInstanceOf(GiftCardVendorUnavailableError)
    expect(callsTo(mockedAxios.post, "/giftcards/purchase/bitcoin")).toHaveLength(1)
  })

  it("never retries a purchase on a network error", async () => {
    mockedAxios.post.mockRejectedValue(networkError("ECONNABORTED"))

    const result = await makeClient().purchase(PURCHASE_ARGS)

    expect(result).toBeInstanceOf(GiftCardVendorUnavailableError)
    expect(callsTo(mockedAxios.post, "/giftcards/purchase/bitcoin")).toHaveLength(1)
  })

  it("maps a 4xx with a vendor message to GiftCardVendorRejectedOrderError", async () => {
    mockedAxios.post.mockImplementation(
      routePost({
        "/giftcards/purchase/bitcoin": () => httpError(400, "Insufficient stock"),
      }),
    )

    const result = await makeClient().purchase(PURCHASE_ARGS)

    expect(result).toBeInstanceOf(GiftCardVendorRejectedOrderError)
    expect((result as Error).message).toBe("Insufficient stock")
  })

  it("maps a 2xx envelope with a 4xx statusCode, null result and an error to a rejection", async () => {
    mockedAxios.post.mockImplementation(
      routePost({
        "/giftcards/purchase/bitcoin": () => ({
          status: 200,
          data: { statusCode: 400, result: null, error: "Card value not allowed" },
        }),
      }),
    )

    const result = await makeClient().purchase(PURCHASE_ARGS)

    expect(result).toBeInstanceOf(GiftCardVendorRejectedOrderError)
    expect((result as Error).message).toBe("Card value not allowed")
  })

  it("maps a 4xx without a vendor message to GiftCardVendorUnavailableError", async () => {
    mockedAxios.post.mockImplementation(
      routePost({ "/giftcards/purchase/bitcoin": () => ({ status: 422, data: {} }) }),
    )

    const result = await makeClient().purchase(PURCHASE_ARGS)

    expect(result).toBeInstanceOf(GiftCardVendorUnavailableError)
  })
})

describe("BitcoinCompanyClient invoice status", () => {
  beforeEach(() => seedTokens(FRESH_TOKENS))

  it("sends the invoice and retries the status POST on a 5xx", async () => {
    mockedAxios.post.mockImplementation(
      routePost({
        "/giftcards/invoice-status": sequence(
          httpError(502, "Bad Gateway"),
          httpOk(FULFILLED_RESULT),
        ),
      }),
    )

    const result = await makeClient().invoiceStatus(INVOICE)

    expect(result).toEqual(FULFILLED_RESULT)
    const calls = callsTo(mockedAxios.post, "/giftcards/invoice-status")
    expect(calls).toHaveLength(2)
    expect(calls[0][1]).toEqual({ invoice: INVOICE })
  })

  it("treats a null result with an error string as vendor-unavailable", async () => {
    mockedAxios.post.mockImplementation(
      routePost({
        "/giftcards/invoice-status": () => ({
          status: 200,
          data: { statusCode: 404, result: null, error: "Invoice not found" },
        }),
      }),
    )

    const result = await makeClient().invoiceStatus(INVOICE)

    expect(result).toBeInstanceOf(GiftCardVendorUnavailableError)
  })
})

describe("BitcoinCompanyClient response validation", () => {
  beforeEach(() => seedTokens(FRESH_TOKENS))

  it.each([
    ["a body that is not an envelope", { hello: "world" }],
    ["a non-object body", "<html>oops</html>"],
    [
      "a result of the wrong shape",
      { statusCode: 200, result: { fiatCost: "abc" }, error: null },
    ],
    [
      "a result missing required fields",
      { statusCode: 200, result: { fiatCost: 25 }, error: null },
    ],
  ])("maps %s to GiftCardVendorUnavailableError", async (_label, data) => {
    mockedAxios.post.mockImplementation(
      routePost({ "/svs/quote-card": () => ({ status: 200, data }) }),
    )

    const result = await makeClient().quoteCard(QUOTE_ARGS)

    expect(result).toBeInstanceOf(GiftCardVendorUnavailableError)
    expect(mockedRecordException).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "critical",
        attributes: { "giftcard.provider": "bitcoinCompany", "giftcard.op": "quote" },
      }),
    )
  })

  it("accepts numeric strings where the vendor sends numbers as text", async () => {
    mockedAxios.post.mockImplementation(
      routePost({
        "/svs/quote-card": () =>
          httpOk({
            fiatCost: "25.00",
            satsCost: "39000",
            satsBack: "585",
            bitcoinPrice: "64102.56",
          }),
      }),
    )

    const result = await makeClient().quoteCard(QUOTE_ARGS)

    expect(result).toEqual({
      fiatCost: 25,
      satsCost: 39000,
      satsBack: 585,
      bitcoinPrice: 64102.56,
    })
  })

  it("applies the configured timeout to every request", async () => {
    mockedAxios.get.mockImplementation(routeGet({ "/giftcards": () => catalogPage([]) }))
    mockedAxios.post.mockImplementation(routePost(quoteRoute))
    const client = makeClient()

    await client.listProducts()
    await client.quoteCard(QUOTE_ARGS)

    expect(mockedAxios.get.mock.calls[0][1]).toEqual(
      expect.objectContaining({ timeout: bitcoinCompanyConfigFixture.timeoutMs }),
    )
    expect(mockedAxios.post.mock.calls[0][2]).toEqual(
      expect.objectContaining({ timeout: bitcoinCompanyConfigFixture.timeoutMs }),
    )
  })
})

describe("BitcoinCompanyClient log hygiene", () => {
  it("never hands a token, credential, or claim value to the logger or the span", async () => {
    // Login + a status response that fails validation WITH claim data in it,
    // so the redacted body-preview path is exercised; then a login response
    // that fails validation WITH a token in it.
    mockedAxios.post.mockImplementation(
      routePost({
        "/auth/login": sequence(
          httpOk(LOGIN_RESULT),
          httpOk({ accessToken: 42, refreshToken: REFRESH_TOKEN_1 }),
        ),
        "/giftcards/invoice-status": () =>
          httpOk({
            status: 123,
            claimData: { codes: [{ value: CLAIM_CODE }], claimLink: CLAIM_LINK },
          }),
      }),
    )
    const client = makeClient()

    const status = await client.invoiceStatus(INVOICE)
    mockRedisStore.clear()
    const relogin = await client.invoiceStatus(INVOICE)

    expect(status).toBeInstanceOf(GiftCardVendorUnavailableError)
    expect(relogin).toBeInstanceOf(GiftCardVendorUnavailableError)

    const logCalls = Object.values(mockedLogger).flatMap((mock) => mock.mock.calls)
    expect(logCalls.length).toBeGreaterThan(0)
    const loggedText = JSON.stringify(logCalls)
    // Prove the redaction path ran, not that the body was merely dropped.
    expect(loggedText).toContain("[REDACTED]")
    for (const secret of SECRET_STRINGS) {
      expect(loggedText).not.toContain(secret)
    }

    const spanText = JSON.stringify(
      mockedRecordException.mock.calls.map(([arg]) => ({
        ...arg,
        error:
          arg.error instanceof Error
            ? `${arg.error.name}: ${arg.error.message}`
            : arg.error,
      })),
    )
    expect(mockedRecordException).toHaveBeenCalled()
    for (const secret of SECRET_STRINGS) {
      expect(spanText).not.toContain(secret)
    }
  })

  it("redactForLog masks sensitive keys at any depth and leaves the rest intact", () => {
    const redacted = redactForLog({
      headers: { Authorization: "Bearer abc", Accept: "application/json" },
      result: {
        status: "Completed",
        claimData: { codes: [{ value: "X" }] },
        nested: [
          { refreshToken: "r", accessToken: "a", token: "t", password: "p", id: 7 },
        ],
      },
    })

    expect(redacted).toEqual({
      headers: { Authorization: "[REDACTED]", Accept: "application/json" },
      result: {
        status: "Completed",
        claimData: "[REDACTED]",
        nested: [
          {
            refreshToken: "[REDACTED]",
            accessToken: "[REDACTED]",
            token: "[REDACTED]",
            password: "[REDACTED]",
            id: 7,
          },
        ],
      },
    })
  })
})
