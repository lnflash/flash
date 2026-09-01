/**
 * Cached reader for the ERPNext "Allowed Country" doctype — the ops-managed
 * list of countries whose residents Bridge can issue Flash a USD virtual
 * account for (rows with `flash_allowed` ticked, toggled at
 * /app/allowed-country). Consulted by the bridgeInitiateKyc country gate.
 *
 * Memoised for ~60s (successes AND failures, mirroring fee-discounts.ts) so
 * an ERPNext outage never turns into a fetch storm and recovers within the
 * TTL.
 *
 * Failure polarity is neither fail-open nor fail-closed: when ERPNext cannot
 * be read, or hands back nothing usable, the reader falls back to the
 * CONFIG default list (`bridge.kycGate.countryAllowlist.defaultCountries`).
 * "Allow everyone" would resume sending ineligible users into a KYC Bridge
 * then refuses; "deny everyone" would block real users from their US account
 * over an ERPNext blip. The config list is the last-known-good policy.
 */
import { toBoolean } from "@services/frappe/coerce"
import ErpNext, { type AllowedCountryDoc } from "@services/frappe/ErpNext"
import { baseLogger } from "@services/logger"

const CACHE_TTL_MS = 60_000

let cache: { value: Set<string>; at: number } | undefined

const ALPHA2 = /^[A-Z]{2}$/

/**
 * Normalises one raw row to an upper-case ISO alpha-2 code, or undefined for
 * garbage (blank/invalid code, or a row whose `flash_allowed` tick is off —
 * re-checked here so a lost query filter cannot widen the allowlist).
 */
export const validateAllowedCountryDoc = (doc: AllowedCountryDoc): string | undefined => {
  if (!doc || typeof doc !== "object") return undefined
  if (!toBoolean(doc.flash_allowed)) return undefined
  const code =
    typeof doc.alpha2_code === "string" ? doc.alpha2_code.trim().toUpperCase() : ""
  return ALPHA2.test(code) ? code : undefined
}

const normaliseFallback = (fallback: readonly string[]): Set<string> =>
  new Set(fallback.map((c) => c.trim().toUpperCase()).filter((c) => ALPHA2.test(c)))

/**
 * The set of allowed alpha-2 country codes. Never throws. On any read
 * failure, or an empty/malformed result, returns the config fallback and
 * caches that decision for the TTL.
 */
export const getAllowedCountries = async ({
  fallback,
}: {
  fallback: readonly string[]
}): Promise<Set<string>> => {
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
