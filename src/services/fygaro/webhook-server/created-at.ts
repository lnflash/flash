/**
 * Fygaro's `createdAt` as something `new Date()` reads correctly.
 *
 * It arrives as epoch SECONDS (`1786940395`), and passing that to `new Date`
 * gets it read as milliseconds — 1970-01-21, which is what every Fygaro audit
 * row has carried in `first_seen_at` since the field was first written. Nothing
 * downstream noticed because the trailing-24h window filters on `last_seen_at`,
 * which is written from `new Date()` and is correct; `first_seen_at` is simply
 * the field an operator reads to answer "when did this payment arrive", and it
 * has been wrong on every row.
 *
 * The magnitude test is what makes this total rather than a guess: epoch
 * seconds for any plausible date stay below 1e11 (that ceiling is the year
 * 5138), while the same instant in milliseconds is three orders larger. So a
 * provider that switches to milliseconds later is read correctly too, instead
 * of reintroducing the mirror image of this bug with dates far in the future.
 *
 * Two things keep that magnitude test from swallowing values it should not:
 *
 * - The epoch branch is entered only for an actual number or a string of 9+
 *   digits. Otherwise `Number("2026")` — a plausible shape for a provider that
 *   switches to date strings — would coerce to 2026 and be read as epoch
 *   seconds, landing on 1970-01-01T00:33:46Z: this same bug, wearing a
 *   different payload.
 * - Zero in any shape (`0`, `"0"`) is treated as ABSENT, not as the epoch
 *   instant. A provider sending 0 for an unset timestamp means "no value", and
 *   honouring it literally would put 1970 back in the column this function
 *   exists to keep out of it.
 *
 * Anything else non-numeric is treated as a date string, and anything
 * unparseable returns undefined so the column stays empty rather than holding a
 * fiction.
 */
const EPOCH_SECONDS_CEILING = 1e11

/**
 * What a quoted epoch timestamp looks like: all digits, and enough of them that
 * it cannot be confused with a year or a compact date. 9 digits is 1973 in
 * seconds; every real timestamp from here on is longer.
 */
const QUOTED_EPOCH = /^-?\d{9,}$/

export const fygaroCreatedAtToIso = (
  createdAt: string | number | undefined | null,
): string | undefined => {
  if (createdAt === undefined || createdAt === null) return undefined

  const trimmed = typeof createdAt === "string" ? createdAt.trim() : ""
  // "" and whitespace-only are absent values, not parseable dates. Note that
  // Number("") and Number(" ") are both 0 — without this they would coerce
  // straight down the epoch path and yield 1970-01-01.
  if (typeof createdAt === "string" && trimmed === "") return undefined

  const numeric = typeof createdAt === "number" ? createdAt : Number(trimmed)
  // Zero means "unset" from any provider that sends it; an operator reading
  // 1970-01-01 in first_seen_at cannot tell that from a real timestamp.
  if (numeric === 0) return undefined

  const looksLikeEpoch = typeof createdAt === "number" || QUOTED_EPOCH.test(trimmed)
  if (looksLikeEpoch && Number.isFinite(numeric)) {
    const ms = Math.abs(numeric) < EPOCH_SECONDS_CEILING ? numeric * 1000 : numeric
    const fromEpoch = new Date(ms)
    return Number.isNaN(fromEpoch.getTime()) ? undefined : fromEpoch.toISOString()
  }

  const parsed = new Date(trimmed || String(createdAt))
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
}
