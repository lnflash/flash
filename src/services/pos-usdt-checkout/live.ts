import {
  LiveUpdateError,
  liveUpdateService,
  Vault,
} from "@app/pos-usdt-checkout/live-updates"
import { RateLimitConfig } from "@domain/rate-limit"
import { RateLimiterExceededError } from "@domain/rate-limit/errors"
import { baseLogger } from "@services/logger"
import { consumeLimiter } from "@services/rate-limit"

import { apnsTransport, checkTopic, loadApnsCredential } from "./apns"
import { flashUsdtCheckout, posUsdtCheckoutEnabled } from "./flash"
import { parseLiveSettings } from "./live-config"
import { posUsdtLiveStore } from "./live-store"
import { loadKeyring, tokenVault } from "./token-vault"

// Configuration: see live-config.ts.

const logger = baseLogger.child({ module: "pos-usdt-live-updates" })

// Read provider status through the same checked, throttled receipt path as the
// foreground poller. A missing completion webhook must not strand a locked sale.
export const readOnlyCheckout = {
  async status(key: string) {
    const service = flashUsdtCheckout()
    return service ? service.followedStatus(key) : null
  },
}

async function limit(config: (typeof RateLimitConfig)[string], key: string) {
  const result = await consumeLimiter({
    rateLimitConfig: config,
    keyToConsume: key as IpAddress,
  })
  if (result instanceof RateLimiterExceededError)
    throw new LiveUpdateError("Too many live update requests. Try again shortly.")
  if (result instanceof Error)
    throw new LiveUpdateError("Live updates are temporarily unavailable.")
}

const report = (event: string, detail: Record<string, unknown>) =>
  logger.warn({ event, ...detail }, "POS USDT live update")

// A file error is reduced to its code, so no path or content reaches a log.
// Config errors from this module's helpers name a variable, never a value.
const reasonOf = (err: unknown) => {
  const code = (err as { code?: string })?.code
  return code ? `key file unreadable (${code})` : (err as Error)?.message || "invalid"
}

function build(env: NodeJS.ProcessEnv) {
  if (!posUsdtCheckoutEnabled())
    return { ok: false as const, reason: "checkout disabled" }
  const settings = parseLiveSettings(env)
  if (!settings.ok) return settings
  let vault: Vault
  try {
    vault = tokenVault(loadKeyring(env))
  } catch (err) {
    return { ok: false as const, reason: reasonOf(err) }
  }
  const service = liveUpdateService({
    store: posUsdtLiveStore,
    checkout: readOnlyCheckout,
    scopes: settings.value.scopes,
    vault,
    limitIp: (ip) => limit(RateLimitConfig.posUsdtLiveConsentPerIp, ip),
    limitReceipt: (key) => limit(RateLimitConfig.posUsdtLiveConsentPerReceipt, key),
    now: () => Date.now(),
    followMs: settings.value.followMs,
    report,
  })
  return { ok: true as const, service }
}

let cached: ReturnType<typeof build> | undefined
let warned = false

/** The opt-in service for the GraphQL API, or null when not configured. */
export function flashLiveUpdates() {
  cached ??= build(process.env)
  if (!cached.ok) {
    if (!warned && process.env.POS_USDT_LIVE_UPDATES_ENABLED === "true") {
      warned = true
      logger.warn({ reason: cached.reason }, "POS USDT live updates are off")
    }
    return null
  }
  return cached.service
}

/** The service and its APNs sandbox transport, for the worker process. */
export function flashLiveWorker(env: NodeJS.ProcessEnv = process.env) {
  const built = build(env)
  if (!built.ok) return built
  try {
    const credential = loadApnsCredential(
      (env.POS_USDT_LIVE_APNS_TEAM_ID || "").trim(),
      (env.POS_USDT_LIVE_APNS_KEY_ID || "").trim(),
      (env.POS_USDT_LIVE_APNS_KEY_FILE || "").trim(),
    )
    const topic = checkTopic((env.POS_USDT_LIVE_APNS_TOPIC || "").trim())
    return {
      ok: true as const,
      service: built.service,
      transport: apnsTransport({ credential, topic }),
    }
  } catch (err) {
    return { ok: false as const, reason: reasonOf(err) }
  }
}
