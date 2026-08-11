/**
 * Cached reader for the ERPNext "Fygaro Settings" Single doctype.
 *
 * The payment webhook consults these settings on every delivery to compute the
 * NET amount to credit and to gate auto-crediting. Hitting ERPNext per payment
 * would hammer it, so the result is memoised for ~60s (both successes AND
 * failures — a failure is cached so an ERPNext outage degrades to record-only
 * without a fetch storm, and recovers within the TTL).
 *
 * A read failure, a missing row, or a malformed row all resolve to `undefined`
 * ("settings unavailable"). Callers must treat `undefined` as a hard stop on
 * auto-credit — never as "assume zero fees" — so a broken settings row can
 * never make Flash credit the gross face value again.
 */
import ErpNext, { type FygaroSettingsDoc } from "@services/frappe/ErpNext"
import { baseLogger } from "@services/logger"

export type FygaroSettings = {
  processor: string
  processorFeePercent: number
  processorFeeFixed: number // USD
  flashMarginPercent: number
  flashMarginFixed: number // USD
  autoCreditLimit: number // USD
  minimumTopup: number // USD
  autoCreditEnabled: boolean
}

const CACHE_TTL_MS = 60_000

let cache: { value: FygaroSettings | undefined; at: number } | undefined

// Coerce a value that ERPNext may send as a number or a numeric string. Returns
// undefined for anything that is not a finite number.
const toFiniteNumber = (value: unknown): number | undefined => {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

// ERPNext Check fields come back as 1/0; be liberal about truthy encodings.
const toBoolean = (value: unknown): boolean =>
  value === 1 || value === true || value === "1"

// Validates the raw doctype into a typed FygaroSettings, or undefined when any
// fee-relevant field is missing / non-numeric / negative (i.e. "garbage").
export const validateFygaroSettings = (
  doc: FygaroSettingsDoc | undefined,
): FygaroSettings | undefined => {
  if (!doc || typeof doc !== "object") return undefined

  const processorFeePercent = toFiniteNumber(doc.processor_fee_percent)
  const processorFeeFixed = toFiniteNumber(doc.processor_fee_fixed)
  const flashMarginPercent = toFiniteNumber(doc.flash_margin_percent)
  const flashMarginFixed = toFiniteNumber(doc.flash_margin_fixed)
  const autoCreditLimit = toFiniteNumber(doc.auto_credit_limit)
  const minimumTopup = toFiniteNumber(doc.minimum_topup)

  const numbers = [
    processorFeePercent,
    processorFeeFixed,
    flashMarginPercent,
    flashMarginFixed,
    autoCreditLimit,
    minimumTopup,
  ]
  // A missing or negative fee/limit is not something we can safely credit off.
  if (numbers.some((n) => n === undefined || n < 0)) return undefined

  return {
    processor: typeof doc.processor === "string" ? doc.processor : "",
    processorFeePercent: processorFeePercent as number,
    processorFeeFixed: processorFeeFixed as number,
    flashMarginPercent: flashMarginPercent as number,
    flashMarginFixed: flashMarginFixed as number,
    autoCreditLimit: autoCreditLimit as number,
    minimumTopup: minimumTopup as number,
    autoCreditEnabled: toBoolean(doc.auto_credit_enabled),
  }
}

/**
 * Returns the current Fygaro Settings, or `undefined` when unavailable
 * (ERPNext unreachable, no row, or a malformed row). Memoised for ~60s.
 */
export const getFygaroSettings = async (): Promise<FygaroSettings | undefined> => {
  const now = Date.now()
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value

  const doc = ErpNext?.getFygaroSettings ? await ErpNext.getFygaroSettings() : undefined
  if (doc instanceof Error) {
    baseLogger.warn(
      { error: doc },
      "Failed to read Fygaro Settings; treating as unavailable (record-only)",
    )
    cache = { value: undefined, at: now }
    return undefined
  }

  const validated = validateFygaroSettings(doc)
  if (!validated) {
    baseLogger.warn({ doc }, "Fygaro Settings row is malformed; treating as unavailable")
  }
  cache = { value: validated, at: now }
  return validated
}

/** Test-only: clears the module cache so specs start from a cold read. */
export const _resetFygaroSettingsCache = (): void => {
  cache = undefined
}
