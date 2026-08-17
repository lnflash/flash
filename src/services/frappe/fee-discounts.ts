/**
 * Cached reader for the ERPNext "Fee Discount" doctype — the operator-managed
 * whitelist of usernames whose FLASH fee is discounted on Fygaro card top-ups
 * and/or Jamaican bank cashouts (processor fees are never discounted).
 *
 * Consulted per top-up webhook delivery and per cashout offer, so the active
 * rows are memoised for ~60s (successes AND failures — a failure is cached so
 * an ERPNext outage degrades to standard fees without a fetch storm, and
 * recovers within the TTL), mirroring fygaro-settings.ts.
 *
 * FAIL-OPEN, deliberately the opposite polarity of Fygaro Settings: a read
 * failure, a missing doctype, or a malformed row resolves to a 0% discount
 * (standard fee). A discount is a bonus on top of an otherwise-valid flow;
 * blocking credits or offers because the discount list is unreadable would
 * turn a courtesy into an outage. Worst case a whitelisted user pays the
 * standard fee for a minute and ops adjusts manually.
 */
import { toBoolean, toFiniteNumber } from "@services/frappe/coerce"
import ErpNext, { type FeeDiscountDoc } from "@services/frappe/ErpNext"
import { baseLogger } from "@services/logger"

export type FeeDiscountFlow = "topup" | "cashout"

type FeeDiscount = {
  // Percentage taken OFF the Flash fee, 0-100 (100 = full waiver).
  discountPercent: number
  appliesToTopup: boolean
  appliesToCashout: boolean
}

const CACHE_TTL_MS = 60_000

let cache: { value: Map<string, FeeDiscount>; at: number } | undefined

// Validates one raw row into a keyed entry, or undefined for garbage (blank
// username, non-numeric or out-of-range percent, or a row the operator has
// deactivated). Malformed rows are dropped individually — one bad row must
// not take out the rest of the whitelist.
// The username key is lowercased: platform usernames are case-insensitive
// (AccountsRepository.findByUsername matches with collation strength 2), so
// account.username carries registration case and the operator may type any
// casing into ERPNext — both sides normalize to lowercase to match.
export const validateFeeDiscountDoc = (
  doc: FeeDiscountDoc,
): { username: string; discount: FeeDiscount } | undefined => {
  if (!doc || typeof doc !== "object") return undefined
  // Honour the operator's Active tick here, not only in the ERPNext query
  // filter. Unticking Active is how a promo ends; if this were enforced by
  // the query string alone, a dropped or malformed filter would silently
  // keep every deactivated row discounting Flash's fee forever — and because
  // the reader deliberately fails open, nothing would alarm.
  if (!toBoolean(doc.active)) return undefined
  const username =
    typeof doc.username === "string" ? doc.username.trim().toLowerCase() : ""
  if (!username) return undefined

  const discountPercent = toFiniteNumber(doc.discount_percent)
  if (discountPercent === undefined || discountPercent < 0 || discountPercent > 100) {
    return undefined
  }

  return {
    username,
    discount: {
      discountPercent,
      appliesToTopup: toBoolean(doc.applies_to_topup),
      appliesToCashout: toBoolean(doc.applies_to_cashout),
    },
  }
}

const loadDiscounts = async (): Promise<Map<string, FeeDiscount>> => {
  const now = Date.now()
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value

  const byUsername = new Map<string, FeeDiscount>()
  const docs = ErpNext?.getFeeDiscounts ? await ErpNext.getFeeDiscounts() : []
  if (docs instanceof Error) {
    baseLogger.warn(
      { error: docs },
      "Failed to read Fee Discounts; failing open to standard fees",
    )
    cache = { value: byUsername, at: now }
    return byUsername
  }

  for (const doc of docs) {
    const validated = validateFeeDiscountDoc(doc)
    if (!validated) {
      baseLogger.warn({ doc }, "Malformed Fee Discount row skipped")
      continue
    }
    byUsername.set(validated.username, validated.discount)
  }
  cache = { value: byUsername, at: now }
  return byUsername
}

/**
 * The Flash-fee discount percent (0-100) for a username in a given flow.
 * Returns 0 for users not on the whitelist, rows not covering the flow, and
 * on ANY read failure (fail-open — see module doc). Never throws.
 */
export const getFlashFeeDiscountPercent = async ({
  username,
  flow,
}: {
  username: string | undefined
  flow: FeeDiscountFlow
}): Promise<number> => {
  if (!username) return 0
  try {
    const discounts = await loadDiscounts()
    // Lowercased to match the map keys — usernames are case-insensitive.
    const discount = discounts.get(username.trim().toLowerCase())
    if (!discount) return 0
    const applies = flow === "topup" ? discount.appliesToTopup : discount.appliesToCashout
    return applies ? discount.discountPercent : 0
  } catch (error) {
    baseLogger.warn(
      { error, username, flow },
      "Fee Discount lookup failed; failing open to the standard fee",
    )
    return 0
  }
}

/** Test-only: clears the module cache so specs start from a cold read. */
export const _resetFeeDiscountsCache = (): void => {
  cache = undefined
}
