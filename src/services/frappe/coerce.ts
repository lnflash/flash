/**
 * Coercion helpers for raw ERPNext/Frappe doctype fields.
 *
 * Frappe's REST API is loose about scalar encodings: a Currency/Float field
 * may arrive as a number or as a numeric string, and a Check field arrives as
 * 1/0 (occasionally "1"/"0"). Every reader of a raw doctype needs the same two
 * coercions, so they live here once — two copies would drift the first time
 * someone teaches one of them a new encoding, and because both coercions fail
 * soft the divergence would be silent.
 *
 * Consumers: fee-discounts.ts, fygaro/webhook-server/fygaro-settings.ts.
 */

/**
 * Coerce a value ERPNext may send as a number or a numeric string. Returns
 * undefined for anything that is not a finite number (blank strings, null,
 * "abc", Infinity) so callers can reject the row rather than treat garbage
 * as zero.
 */
export const toFiniteNumber = (value: unknown): number | undefined => {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** ERPNext Check fields come back as 1/0; be liberal about truthy encodings. */
export const toBoolean = (value: unknown): boolean =>
  value === 1 || value === true || value === "1"
