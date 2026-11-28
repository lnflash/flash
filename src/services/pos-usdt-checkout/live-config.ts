import { DEFAULT_FOLLOW_MS, MAX_FOLLOW_MS } from "@app/pos-usdt-checkout/live-updates"

/**
 * Operator configuration for POS USDT live updates. Everything is off unless
 * every required value is present and valid; an invalid value turns the
 * feature off with a reason that names the variable, never its value.
 *
 * API and worker:
 *   POS_USDT_CHECKOUT_ENABLED=true          the checkout itself (flash.ts)
 *   POS_USDT_LIVE_UPDATES_ENABLED=true
 *   POS_USDT_LIVE_APNS_ENVIRONMENT=sandbox  the only accepted value
 *   POS_USDT_LIVE_SCOPES                    comma-separated endpoints, exactly
 *                                           as the app hashes them into the
 *                                           sale key (1-3, canonical URL form)
 *   POS_USDT_LIVE_TOKEN_KEYS or POS_USDT_LIVE_TOKEN_KEYS_FILE  (token-vault.ts)
 *   POS_USDT_LIVE_FOLLOW_MINUTES            1-480, default 60
 *
 * Worker only (src/servers/pos-usdt-live-worker.ts):
 *   POS_USDT_LIVE_APNS_TEAM_ID, POS_USDT_LIVE_APNS_KEY_ID
 *   POS_USDT_LIVE_APNS_KEY_FILE             the .p8, not readable by "other"
 *   POS_USDT_LIVE_APNS_TOPIC                "<bundle id>.push-type.liveactivity"
 */

export type LiveSettings = { scopes: string[]; followMs: number }
export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string }

export function parseScopes(raw: string | undefined): Parsed<string[]> {
  const scopes = (raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  if (!scopes.length || scopes.length > 3)
    return { ok: false, reason: "POS_USDT_LIVE_SCOPES needs 1 to 3 endpoints" }
  for (const scope of scopes) {
    let url: URL
    try {
      url = new URL(scope)
    } catch {
      return { ok: false, reason: "POS_USDT_LIVE_SCOPES has an invalid URL" }
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      // The app hashes the canonical text; anything else could never match.
      url.toString() !== scope
    )
      return {
        ok: false,
        reason: "POS_USDT_LIVE_SCOPES must list canonical endpoint URLs",
      }
  }
  return { ok: true, value: scopes }
}

export function parseLiveSettings(env: NodeJS.ProcessEnv): Parsed<LiveSettings> {
  if (env.POS_USDT_LIVE_UPDATES_ENABLED !== "true")
    return { ok: false, reason: "POS_USDT_LIVE_UPDATES_ENABLED is not true" }
  // Production pushes are not implemented; sandbox must be said explicitly.
  if (env.POS_USDT_LIVE_APNS_ENVIRONMENT !== "sandbox")
    return { ok: false, reason: "POS_USDT_LIVE_APNS_ENVIRONMENT is not sandbox" }
  const scopes = parseScopes(env.POS_USDT_LIVE_SCOPES)
  if (!scopes.ok) return scopes
  const minutes = (env.POS_USDT_LIVE_FOLLOW_MINUTES || "").trim()
  let followMs = DEFAULT_FOLLOW_MS
  if (minutes) {
    if (!/^[1-9]\d{0,2}$/.test(minutes) || Number(minutes) * 60_000 > MAX_FOLLOW_MS)
      return { ok: false, reason: "POS_USDT_LIVE_FOLLOW_MINUTES must be 1 to 480" }
    followMs = Number(minutes) * 60_000
  }
  return { ok: true, value: { scopes: scopes.value, followMs } }
}
