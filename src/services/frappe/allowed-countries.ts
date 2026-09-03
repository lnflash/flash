/**
 * The set of countries whose residents Bridge can issue Flash a USD virtual
 * account for, consulted by the bridgeInitiateKyc country gate.
 *
 * Where it comes from is `bridge.kycGate.countryAllowlist.source`:
 *
 * - `"config"` (default): `defaultCountries` IS the list. No ERPNext read, no
 *   cache. This makes the gate safe to deploy on its own — the ERPNext
 *   doctype as seeded before the frappe-flash-admin reseed ticks
 *   `flash_allowed` for 165 countries, NG and IN among them.
 * - `"erpnext"`: the ops-managed ERPNext "Allowed Country" doctype (rows with
 *   `flash_allowed` ticked, toggled at /app/allowed-country), memoised for
 *   ~60s (successes AND failures, mirroring fee-discounts.ts) so an ERPNext
 *   outage never turns into a fetch storm and recovers within the TTL.
 *
 *   Failure polarity is neither fail-open nor fail-closed: when ERPNext
 *   cannot be read, or hands back nothing usable, the reader falls back to
 *   `defaultCountries`. "Allow everyone" would resume sending ineligible users
 *   into a KYC Bridge then refuses; "deny everyone" would block real users
 *   from their US account over an ERPNext blip. The config list is the
 *   last-known-good policy.
 */
import { toAlpha2, toBoolean } from "@services/frappe/coerce"
import ErpNext, { type AllowedCountryDoc } from "@services/frappe/ErpNext"
import { baseLogger } from "@services/logger"

const CACHE_TTL_MS = 60_000

let cache: { value: Set<string>; at: number } | undefined

/**
 * Normalises one raw row to an upper-case ISO alpha-2 code, or undefined for
 * garbage (blank/invalid code, or a row whose `flash_allowed` tick is off —
 * re-checked here so a lost query filter cannot widen the allowlist).
 */
export const validateAllowedCountryDoc = (doc: AllowedCountryDoc): string | undefined => {
  if (!doc || typeof doc !== "object") return undefined
  if (!toBoolean(doc.flash_allowed)) return undefined
  return toAlpha2(doc.alpha2_code)
}

const normaliseFallback = (fallback: readonly string[]): Set<string> => {
  const codes = new Set<string>()
  for (const entry of fallback) {
    const code = toAlpha2(entry)
    if (code) codes.add(code)
  }
  return codes
}

/**
 * The set of allowed alpha-2 country codes. Never throws. With
 * `source: "config"` this is the normalised `fallback` list and nothing else
 * is consulted. With `source: "erpnext"`, on any read failure or an
 * empty/malformed result, returns the config fallback and caches that
 * decision for the TTL.
 */
export const getAllowedCountries = async ({
  source,
  fallback,
}: {
  source: BridgeKycCountryAllowlistSource
  fallback: readonly string[]
}): Promise<Set<string>> => {
  if (source === "config") return normaliseFallback(fallback)

  const now = Date.now()
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value

  let docs: AllowedCountryDoc[] | Error
  try {
    docs = ErpNext?.getAllowedCountries ? await ErpNext.getAllowedCountries() : []
  } catch (error) {
    docs = error instanceof Error ? error : new Error(String(error))
  }

  if (docs instanceof Error) {
    const value = normaliseFallback(fallback)
    baseLogger.warn(
      { error: docs, fallbackCount: value.size },
      "Failed to read Allowed Country; falling back to the config allowlist",
    )
    cache = { value, at: now }
    return value
  }

  const allowed = new Set<string>()
  for (const doc of docs) {
    const code = validateAllowedCountryDoc(doc)
    if (!code) {
      baseLogger.warn({ doc }, "Malformed Allowed Country row skipped")
      continue
    }
    allowed.add(code)
  }

  if (allowed.size === 0) {
    // An empty allowlist is far more likely a broken read (missing doctype,
    // wrong site, permissions) than a deliberate "no country at all" policy.
    const value = normaliseFallback(fallback)
    baseLogger.info(
      { fallbackCount: value.size },
      "Allowed Country returned no allowed rows; using the config allowlist",
    )
    cache = { value, at: now }
    return value
  }

  cache = { value: allowed, at: now }
  return allowed
}

/** Test-only: clears the module cache so specs start from a cold read. */
export const _resetAllowedCountriesCache = (): void => {
  cache = undefined
}
