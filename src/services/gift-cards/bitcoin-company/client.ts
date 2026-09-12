import { randomUUID } from "crypto"

import axios, { isAxiosError } from "axios"
import { z } from "zod"

import { GiftCardsConfig } from "@config"

import {
  GiftCardError,
  GiftCardVendorRejectedOrderError,
  GiftCardVendorUnavailableError,
} from "@domain/gift-cards"
import { ErrorLevel } from "@domain/shared"
import { baseLogger } from "@services/logger"
import {
  addAttributesToCurrentSpan,
  recordExceptionInCurrentSpan,
} from "@services/tracing"

import {
  BitcoinCompanyApiError,
  BitcoinCompanyAuthError,
  BitcoinCompanyError,
  BitcoinCompanyNetworkError,
  BitcoinCompanyResponseShapeError,
  BitcoinCompanyUnauthorizedError,
} from "./errors"
import {
  CachedTokens,
  VendorAuthTokens,
  VendorProduct,
  VendorPurchase,
  VendorPurchasedProduct,
  VendorQuote,
  authTokensSchema,
  cachedTokensSchema,
  catalogPageSchema,
  envelopeSchema,
  purchaseResultSchema,
  purchasedProductSchema,
  quoteResultSchema,
  vendorProductSchema,
} from "./schemas"

/**
 * Bitcoin Company HTTP client: transport, auth token lifecycle, retries, and
 * the translation of every failure into a domain `GiftCard*` error. Nothing
 * vendor-shaped escapes this file except the validated `Vendor*` types that
 * `mapping.ts` consumes.
 *
 * Auth model (vendor): `POST /auth/login` returns an access token (1h) and a
 * refresh token (21d). `GET /auth/refresh-token` with the refresh token as the
 * bearer returns a new pair. We cache the pair in Redis so every pod shares
 * one session, refresh when the access token has < 5 min left, and on a 401
 * refresh once and retry once. A failed refresh falls back to a fresh login.
 * A short `SET NX` lock keeps concurrent pods from racing each other through
 * login/refresh; losing the lock never blocks a request, it only means a
 * duplicate login, which the vendor tolerates.
 *
 * Redis is deliberately OFF the critical path: a read or write failure is
 * logged and the request proceeds with a fresh login.
 */

type BitcoinCompanyConfig = GiftCardsConfig["providers"]["bitcoinCompany"]

export const BITCOIN_COMPANY_AUTH_CACHE_KEY = "giftcards:auth:bitcoinCompany"
export const BITCOIN_COMPANY_AUTH_LOCK_KEY = "giftcards:auth:bitcoinCompany:lock"

const PROVIDER = "bitcoinCompany"

// Vendor-stated lifetimes. Access tokens are not decoded; if the vendor
// shortens the lifetime the 401 → refresh → retry path still covers it.
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000
const REFRESH_TOKEN_TTL_MS = 21 * 24 * 60 * 60 * 1000
const ACCESS_REFRESH_MARGIN_MS = 5 * 60 * 1000

const AUTH_LOCK_TTL_MS = 10_000
const AUTH_LOCK_POLL_MS = 100
const AUTH_LOCK_MAX_POLLS = 50

/** Retries after the first attempt, for idempotent reads only. */
export const RETRY_MAX = 3
const RETRY_BASE_MS = 200
const RETRY_JITTER_MS = 100

export const CATALOG_PAGE_SIZE = 500
/** Hard stop so a vendor that never returns an empty page cannot loop forever. */
export const CATALOG_MAX_PAGES = 200

const LOG_BODY_PREVIEW_CHARS = 2000

// ============ Log redaction ============

const SENSITIVE_LOG_KEYS: ReadonlySet<string> = new Set([
  "authorization",
  "accesstoken",
  "refreshtoken",
  "token",
  "password",
  "claimdata",
  "codes",
  "claimlink",
  "barcodechars",
  "barcodetype",
])

/** Replaces token, credential, and claim values anywhere in an object tree. */
export const redactForLog = (value: unknown, depth = 0): unknown => {
  if (depth > 8) return "[TRUNCATED]"
  if (Array.isArray(value)) return value.map((item) => redactForLog(item, depth + 1))
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      out[key] = SENSITIVE_LOG_KEYS.has(key.toLowerCase())
        ? "[REDACTED]"
        : redactForLog(item, depth + 1)
    }
    return out
  }
  return value
}

const bodyPreview = (data: unknown): string => {
  try {
    return JSON.stringify(redactForLog(data)).slice(0, LOG_BODY_PREVIEW_CHARS)
  } catch {
    return "[unserialisable]"
  }
}

const errorName = (err: unknown): string => (err instanceof Error ? err.name : "unknown")

// ============ Token store ============

export type ReleaseLock = () => Promise<void>

export interface TokenStore {
  read(): Promise<CachedTokens | null>
  write(tokens: CachedTokens): Promise<void>
  clear(): Promise<void>
  /** A release fn when acquired, null when another holder has the lock. */
  tryLock(): Promise<ReleaseLock | null>
}

// Compare-and-delete so a pod never releases a lock that expired and was
// re-acquired by someone else.
const RELEASE_LOCK_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end'

/**
 * Redis-backed store. `@services/redis` opens a connection as a module side
 * effect, so it is imported on first use rather than at load: unit tests and
 * anything that merely imports the provider registry never touch Redis.
 */
export const RedisTokenStore = (): TokenStore => {
  const client = async () => (await import("@services/redis")).redis

  return {
    read: async () => {
      const raw = await (await client()).get(BITCOIN_COMPANY_AUTH_CACHE_KEY)
      if (!raw) return null
      let json: unknown
      try {
        json = JSON.parse(raw)
      } catch {
        return null
      }
      const parsed = cachedTokensSchema.safeParse(json)
      return parsed.success ? parsed.data : null
    },
    write: async (tokens) => {
      await (
        await client()
      ).set(
        BITCOIN_COMPANY_AUTH_CACHE_KEY,
        JSON.stringify(tokens),
        "PX",
        REFRESH_TOKEN_TTL_MS,
      )
    },
    clear: async () => {
      await (await client()).del(BITCOIN_COMPANY_AUTH_CACHE_KEY)
    },
    tryLock: async () => {
      const redis = await client()
      const nonce = randomUUID()
      const acquired = await redis.set(
        BITCOIN_COMPANY_AUTH_LOCK_KEY,
        nonce,
        "PX",
        AUTH_LOCK_TTL_MS,
        "NX",
      )
      if (acquired !== "OK") return null
      return async () => {
        await redis.eval(RELEASE_LOCK_SCRIPT, 1, BITCOIN_COMPANY_AUTH_LOCK_KEY, nonce)
      }
    },
  }
}

/** Single-process store for tests and scripts. */
export const InMemoryTokenStore = (): TokenStore => {
  let tokens: CachedTokens | null = null
  let locked = false
  return {
    read: async () => tokens,
    write: async (next) => {
      tokens = next
    },
    clear: async () => {
      tokens = null
    },
    tryLock: async () => {
      if (locked) return null
      locked = true
      return async () => {
        locked = false
      }
    },
  }
}

// ============ Client ============

type HttpMethod = "GET" | "POST"

type RequestSpec = {
  op: string
  method: HttpMethod
  path: string
  body?: unknown
  /** Send the bearer token and treat a 401 as "refresh once, retry once". */
  auth: boolean
}

type CallArgs<T> = RequestSpec & {
  /** Retry network errors and 5xx. Only for idempotent reads. */
  retry: boolean
  schema: z.ZodType<T, z.ZodTypeDef, unknown>
}

type ParseArgs<T> = {
  op: string
  schema: z.ZodType<T, z.ZodTypeDef, unknown>
  /** Auth responses are never previewed in logs, redaction or not. */
  logBody: boolean
}

export type BitcoinCompanyClientDeps = {
  getConfig?: () => BitcoinCompanyConfig
  tokenStore?: TokenStore
  /** Epoch millis. */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** [0, 1). Injected so tests can pin the retry jitter. */
  random?: () => number
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

const extractVendorError = (data: unknown): string | null => {
  if (!data || typeof data !== "object") return null
  const { error, message } = data as { error?: unknown; message?: unknown }
  if (typeof error === "string" && error.length > 0) return error
  if (typeof message === "string" && message.length > 0) return message
  if (Array.isArray(message) && message.every((m) => typeof m === "string")) {
    return message.join("; ")
  }
  return null
}

export class BitcoinCompanyClient {
  private readonly getConfig: () => BitcoinCompanyConfig
  private readonly tokenStore: TokenStore
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly random: () => number

  constructor(deps: BitcoinCompanyClientDeps = {}) {
    // Config is read per call, not at construction, so `@config` can be mocked
    // after this module loads and config reloads are picked up.
    this.getConfig = deps.getConfig ?? (() => GiftCardsConfig.providers.bitcoinCompany)
    this.tokenStore = deps.tokenStore ?? RedisTokenStore()
    this.now = deps.now ?? Date.now
    this.sleep = deps.sleep ?? defaultSleep
    this.random = deps.random ?? Math.random
  }

  // ============ Public operations ============

  /**
   * Full catalog, paginated. Public endpoint, no auth. A product row that
   * fails validation is skipped and counted, not fatal to the sync.
   *
   * The offset advances by the rows the vendor actually returned, never by the
   * requested page size: a vendor that clamps `size` (100 is a common cap) or
   * returns short pages for any other reason would otherwise silently truncate
   * the catalog or skip products. The only end-of-catalog signal is an empty
   * page, so every sync costs one extra request. Invalid rows still count
   * toward the offset; they occupy a slot on the vendor's side regardless.
   *
   * Hitting the page cap without an empty page fails the sync rather than
   * returning a partial catalog: a vendor that ignores `offset` would
   * otherwise hand the sync a duplicate-heavy list that overwrites the last
   * good catalog wholesale. Failing keeps the previous catalog serving.
   */
  async listProducts(): Promise<VendorProduct[] | GiftCardError> {
    const products: VendorProduct[] = []
    let skipped = 0
    let offset = 0
    let pages = 0
    let reachedEnd = false

    while (pages < CATALOG_MAX_PAGES) {
      const result = await this.call({
        op: "listProducts",
        method: "GET",
        path: `/giftcards?size=${CATALOG_PAGE_SIZE}&offset=${offset}`,
        auth: false,
        retry: true,
        schema: catalogPageSchema,
      })
      if (result instanceof Error) return result
      pages++

      if (result.svs.length === 0) {
        reachedEnd = true
        break
      }

      for (const row of result.svs) {
        const parsed = vendorProductSchema.safeParse(row)
        if (parsed.success) {
          products.push(parsed.data)
        } else {
          skipped++
        }
      }
      offset += result.svs.length
    }

    if (!reachedEnd) {
      baseLogger.warn(
        { provider: PROVIDER, op: "listProducts", pages, offset, kept: products.length },
        "Bitcoin Company catalog page cap reached before an empty page; failing the sync",
      )
      return new GiftCardVendorUnavailableError()
    }

    if (skipped > 0) {
      baseLogger.warn(
        { provider: PROVIDER, op: "listProducts", skipped, kept: products.length },
        "Bitcoin Company catalog rows failed validation and were skipped",
      )
    }
    return products
  }

  async quoteCard(args: {
    productId: string
    /** Major units of the product currency. */
    cardValue: number
    quantity: number
  }): Promise<VendorQuote | GiftCardError> {
    return this.call({
      op: "quote",
      method: "POST",
      path: "/svs/quote-card",
      body: {
        productId: args.productId,
        cardValue: args.cardValue,
        quantity: args.quantity,
        purchaseType: "Lightning",
      },
      auth: true,
      retry: false,
      schema: quoteResultSchema,
    })
  }

  /** Never retried: a retry could mint a second invoice for the same order. */
  async purchase(args: {
    productId: string
    /** Major units of the product currency. */
    cardValue: number
    quantity: number
    /** Our order id, stored by the vendor as the order label. */
    label: string
  }): Promise<VendorPurchase | GiftCardError> {
    return this.call({
      op: "createOrder",
      method: "POST",
      path: "/giftcards/purchase/bitcoin",
      body: {
        productId: args.productId,
        cardValue: args.cardValue,
        quantity: args.quantity,
        useUsdBalance: false,
        useSatsBalance: false,
        label: args.label,
      },
      auth: true,
      retry: false,
      schema: purchaseResultSchema,
    })
  }

  /** Idempotent read despite being a POST; retried like a GET. */
  async invoiceStatus(invoice: string): Promise<VendorPurchasedProduct | GiftCardError> {
    return this.call({
      op: "getOrder",
      method: "POST",
      path: "/giftcards/invoice-status",
      body: { invoice },
      auth: true,
      retry: true,
      schema: purchasedProductSchema,
    })
  }

  // ============ Request pipeline ============

  private async call<T>(args: CallArgs<T>): Promise<T | GiftCardError> {
    addAttributesToCurrentSpan({ "giftcard.provider": PROVIDER, "giftcard.op": args.op })
    try {
      const data = await this.sendWithAuth(args)
      return this.parseEnvelope({ op: args.op, schema: args.schema, logBody: true }, data)
    } catch (err) {
      return this.toGiftCardError(args.op, err)
    }
  }

  private async sendWithAuth<T>(args: CallArgs<T>): Promise<unknown> {
    if (!args.auth) return this.sendWithRetry(args, null)

    const token = await this.getAccessToken()
    try {
      return await this.sendWithRetry(args, token)
    } catch (err) {
      if (!(err instanceof BitcoinCompanyUnauthorizedError)) throw err
      baseLogger.info(
        { provider: PROVIDER, op: args.op },
        "Bitcoin Company rejected the access token; refreshing and retrying once",
      )
      const fresh = await this.getAccessToken({ rejected: token })
      // A second 401 propagates: the session is broken, not merely stale.
      return this.sendWithRetry(args, fresh)
    }
  }

  private async sendWithRetry<T>(
    args: CallArgs<T>,
    token: string | null,
  ): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.sendOnce(args, token)
      } catch (err) {
        const retryable =
          err instanceof BitcoinCompanyNetworkError ||
          (err instanceof BitcoinCompanyApiError && err.status >= 500)
        if (!args.retry || !retryable || attempt >= RETRY_MAX) throw err

        const delayMs =
          RETRY_BASE_MS * 2 ** attempt + Math.floor(this.random() * RETRY_JITTER_MS)
        baseLogger.warn(
          {
            provider: PROVIDER,
            op: args.op,
            attempt: attempt + 1,
            delayMs,
            reason: err.name,
          },
          "Bitcoin Company call failed; retrying",
        )
        await this.sleep(delayMs)
      }
    }
  }

  private async sendOnce(spec: RequestSpec, token: string | null): Promise<unknown> {
    const config = this.getConfig()
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json",
    }
    if (token) headers["Authorization"] = `Bearer ${token}`

    const requestConfig = {
      headers,
      timeout: config.timeoutMs,
      // Resolve every status so 4xx/5xx are handled below, not as thrown AxiosErrors.
      validateStatus: () => true,
    }
    const url = `${config.baseUrl.replace(/\/+$/, "")}${spec.path}`

    let response: { status: number; data: unknown }
    try {
      response =
        spec.method === "GET"
          ? await axios.get(url, requestConfig)
          : await axios.post(url, spec.body ?? {}, requestConfig)
    } catch (err) {
      // With validateStatus above, an AxiosError without a response is a
      // connection, DNS, or timeout failure.
      if (isAxiosError(err) && !err.response) {
        throw new BitcoinCompanyNetworkError(err.code ?? err.message)
      }
      throw err
    }

    if (response.status === 401 && spec.auth) {
      throw new BitcoinCompanyUnauthorizedError(`${spec.op}: HTTP 401`)
    }
    if (response.status >= 400) {
      throw new BitcoinCompanyApiError(
        `${spec.op}: HTTP ${response.status}`,
        response.status,
        extractVendorError(response.data),
      )
    }
    return response.data
  }

  private parseEnvelope<T>(args: ParseArgs<T>, data: unknown): T {
    let issues: { path: string; code: string }[]

    const envelope = envelopeSchema.safeParse(data)
    // zod drops absent keys, so `in` distinguishes a missing result from an explicit null.
    if (envelope.success && "result" in envelope.data) {
      const { result, statusCode, error } = envelope.data
      if (result === null) {
        // Some vendor errors ride inside a 2xx envelope with a null result.
        throw new BitcoinCompanyApiError(
          `${args.op}: empty result`,
          statusCode ?? 200,
          error ?? null,
        )
      }
      const parsed = args.schema.safeParse(result)
      if (parsed.success) return parsed.data
      issues = parsed.error.issues.map((issue) => ({
        path: ["result", ...issue.path].join("."),
        code: issue.code,
      }))
    } else if (envelope.success) {
      issues = [{ path: "result", code: "missing" }]
    } else {
      issues = envelope.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
      }))
    }

    baseLogger.warn(
      {
        provider: PROVIDER,
        op: args.op,
        issues: issues.slice(0, 5),
        ...(args.logBody ? { body: bodyPreview(data) } : {}),
      },
      "Bitcoin Company response failed validation",
    )
    throw new BitcoinCompanyResponseShapeError(`${args.op}: unexpected response shape`)
  }

  private toGiftCardError(op: string, err: unknown): GiftCardError {
    const attributes = { "giftcard.provider": PROVIDER, "giftcard.op": op }

    if (err instanceof BitcoinCompanyApiError) {
      recordExceptionInCurrentSpan({ error: err, level: ErrorLevel.Warn, attributes })
      baseLogger.warn(
        { provider: PROVIDER, op, status: err.status, vendorError: err.vendorError },
        "Bitcoin Company rejected the request",
      )
      if (
        op === "createOrder" &&
        err.status >= 400 &&
        err.status < 500 &&
        err.vendorError
      ) {
        return new GiftCardVendorRejectedOrderError(err.vendorError)
      }
      return new GiftCardVendorUnavailableError()
    }

    if (err instanceof BitcoinCompanyError) {
      recordExceptionInCurrentSpan({ error: err, level: err.level, attributes })
      baseLogger.error(
        { provider: PROVIDER, op, reason: err.name, detail: err.message },
        "Bitcoin Company call failed",
      )
      return new GiftCardVendorUnavailableError()
    }

    recordExceptionInCurrentSpan({
      error: err,
      level: ErrorLevel.Critical,
      attributes,
      fallbackMsg: "Unexpected error in Bitcoin Company client",
    })
    baseLogger.error(
      { provider: PROVIDER, op, reason: errorName(err) },
      "Bitcoin Company client threw unexpectedly",
    )
    return new GiftCardVendorUnavailableError()
  }

  // ============ Auth ============

  private async getAccessToken(opts: { rejected?: string | null } = {}): Promise<string> {
    const cached = await this.readTokens()
    if (cached && this.isUsable(cached, opts.rejected)) return cached.accessToken

    return this.withAuthLock(async () => {
      // Another pod may have refreshed while we waited for the lock.
      const latest = await this.readTokens()
      if (latest && this.isUsable(latest, opts.rejected)) return latest.accessToken

      const refreshToken = latest?.refreshToken ?? cached?.refreshToken ?? null
      if (refreshToken) {
        const refreshed = await this.refresh(refreshToken)
        if (refreshed) return refreshed.accessToken
      }
      return (await this.login()).accessToken
    })
  }

  private isUsable(tokens: CachedTokens, rejected?: string | null): boolean {
    if (rejected && tokens.accessToken === rejected) return false
    return tokens.accessExpiresAt - this.now() > ACCESS_REFRESH_MARGIN_MS
  }

  /** Not retried: a rotated refresh token makes a replay actively harmful. */
  private async refresh(refreshToken: string): Promise<CachedTokens | null> {
    try {
      const data = await this.sendOnce(
        { op: "refreshToken", method: "GET", path: "/auth/refresh-token", auth: false },
        refreshToken,
      )
      const pair = this.parseEnvelope(
        { op: "refreshToken", schema: authTokensSchema, logBody: false },
        data,
      )
      const tokens = await this.storeTokens(pair)
      baseLogger.info(
        { provider: PROVIDER, op: "refreshToken" },
        "Bitcoin Company access token refreshed",
      )
      return tokens
    } catch (err) {
      baseLogger.warn(
        { provider: PROVIDER, op: "refreshToken", reason: errorName(err) },
        "Bitcoin Company token refresh failed; falling back to login",
      )
      return null
    }
  }

  /** Not retried: never replay credentials. */
  private async login(): Promise<CachedTokens> {
    const { email, password } = this.getConfig()
    if (!email || !password) {
      throw new BitcoinCompanyAuthError("Bitcoin Company credentials are not configured")
    }

    let data: unknown
    try {
      data = await this.sendOnce(
        {
          op: "login",
          method: "POST",
          path: "/auth/login",
          body: { email, password },
          auth: false,
        },
        null,
      )
    } catch (err) {
      throw new BitcoinCompanyAuthError(`Bitcoin Company login failed: ${errorName(err)}`)
    }

    const pair = this.parseEnvelope(
      { op: "login", schema: authTokensSchema, logBody: false },
      data,
    )
    const tokens = await this.storeTokens(pair)
    baseLogger.info(
      { provider: PROVIDER, op: "login" },
      "Bitcoin Company login succeeded",
    )
    return tokens
  }

  private async storeTokens(pair: VendorAuthTokens): Promise<CachedTokens> {
    const tokens: CachedTokens = {
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      accessExpiresAt: this.now() + ACCESS_TOKEN_TTL_MS,
    }
    try {
      await this.tokenStore.write(tokens)
    } catch (err) {
      baseLogger.warn(
        { provider: PROVIDER, reason: errorName(err) },
        "Bitcoin Company token cache write failed; continuing without cache",
      )
    }
    return tokens
  }

  private async readTokens(): Promise<CachedTokens | null> {
    try {
      return await this.tokenStore.read()
    } catch (err) {
      baseLogger.warn(
        { provider: PROVIDER, reason: errorName(err) },
        "Bitcoin Company token cache read failed; treating as empty",
      )
      return null
    }
  }

  /**
   * Best-effort cross-pod mutual exclusion. Waits up to ~5s for the holder;
   * a lock-store failure or exhausted wait proceeds unlocked with a warning.
   */
  private async withAuthLock<T>(fn: () => Promise<T>): Promise<T> {
    let release: ReleaseLock | null = null
    let storeFailed = false

    for (let poll = 0; poll < AUTH_LOCK_MAX_POLLS; poll++) {
      try {
        release = await this.tokenStore.tryLock()
      } catch (err) {
        storeFailed = true
        baseLogger.warn(
          { provider: PROVIDER, reason: errorName(err) },
          "Bitcoin Company auth lock unavailable; proceeding without it",
        )
        break
      }
      if (release) break
      await this.sleep(AUTH_LOCK_POLL_MS)
    }

    if (!release && !storeFailed) {
      baseLogger.warn(
        { provider: PROVIDER },
        "Bitcoin Company auth lock wait exhausted; proceeding without it",
      )
    }

    try {
      return await fn()
    } finally {
      if (release) {
        try {
          await release()
        } catch (err) {
          baseLogger.warn(
            { provider: PROVIDER, reason: errorName(err) },
            "Bitcoin Company auth lock release failed; it will expire on its own",
          )
        }
      }
    }
  }
}
