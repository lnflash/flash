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
 * - Anything that coerces to a non-positive number (`0`, `"0"`, `-1`, `"-1"`)
 *   is treated as ABSENT. Both are common "unset timestamp" sentinels, and
 *   Fygaro is a card processor that did not exist before 1970, so a negative
 *   value here is garbage by construction. Honouring either literally would put
 *   a 1969/1970 date back in the column this function exists to keep it out of.
 *
 * Anything else non-numeric is treated as a date string, and ONLY ISO-8601 is
 * accepted. A naive datetime with no zone (`"2026-08-17 15:00:00"`, the shape
 * Frappe itself emits) is pinned to UTC before parsing — `new Date` reads that
 * form as HOST-LOCAL time, which would shift the answer by the container's UTC
 * offset and, in the site's configured `America/Adak`, onto the wrong calendar
 * day. Everything else returns undefined so the column stays empty rather than
 * holding a fiction.
 *
 * That ISO restriction is the difference between "pinned to UTC" being true and
 * being true of one shape. `new Date`'s legacy non-ISO parser is
 * implementation-defined and host-local for zoneless input, so
 * `"Mon, 17 Aug 2026 15:00:00"` reads as 15:00Z under TZ=UTC and as the NEXT
 * calendar day under `America/Adak` — the same slide, one format over. Refusing
 * the format is honest; parsing it and claiming a UTC guarantee is not.
 */
const EPOCH_SECONDS_CEILING = 1e11

/**
 * The other end of the magnitude test. 1e8 seconds is 1973 — below any real
 * timestamp and four orders below any real one in milliseconds — so a small
 * bare number is not a clock reading at all.
 *
 * Without this the ceiling was one-sided and the digit-count gate only guarded
 * STRINGS: the number `2026` sailed into the epoch branch and came back as
 * 1970-01-01T00:33:46Z, while the string `"2026"` was correctly read as a year.
 * The same value giving two answers depending on how the JSON happened to be
 * serialised is the exact shape of the bug this file exists to close.
 */
const EPOCH_SECONDS_FLOOR = 1e8

/**
 * What a quoted epoch timestamp looks like: digits, and enough of them that it
 * cannot be confused with a year or a compact date. 9 digits is 1973 in
 * seconds; every real timestamp from here on is longer. A fractional part is
 * allowed because that is what a provider emits when it stringifies a float
 * clock (`"1786940395.75"`) — the number form of that value is already read
 * correctly, and the string form must not silently blank the column. No sign is
 * allowed: `-` is handled as "unset" below, and a leading `+` is accepted only
 * because `Number` accepts it.
 */
const QUOTED_EPOCH = /^\+?\d{9,}(\.\d+)?$/

/**
 * A datetime with no zone designator — `"2026-08-17 15:00:00"` or the `T`
 * form. `new Date` reads these as host-local time, so they are pinned to UTC
 * explicitly rather than picking up the container's offset.
 */
const NAIVE_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/

/**
 * ISO-8601, the only date-string shape accepted. Year, year-month or full date,
 * optionally a time, optionally a zone. These are the forms `new Date` parses by
 * SPEC — date-only as UTC, and the zoneless datetime pinned above — rather than
 * by the legacy fallback parser, whose behaviour is implementation-defined and
 * host-TZ dependent.
 */
const ISO_DATE =
  /^\d{4}(-\d{2}(-\d{2})?)?([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/

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
  // A timestamp is a POSITIVE number. Zero and negatives are both stock "unset"
  // sentinels, and an operator reading 1970-01-01 (or 1969-12-31) in
  // first_seen_at cannot tell either from a real timestamp. NaN deliberately
  // falls through this comparison — that is a date string like "2026-08-17",
  // which the date branch below handles.
  if (numeric <= 0) return undefined

  const looksLikeEpoch = typeof createdAt === "number" || QUOTED_EPOCH.test(trimmed)
  if (looksLikeEpoch) {
    // Below the floor a bare number is not a clock reading, and there is nothing
    // honest to fall back on: reading `2026` as a year is as much a guess as
    // reading it as epoch seconds. An empty column beats either.
    if (!Number.isFinite(numeric) || numeric < EPOCH_SECONDS_FLOOR) return undefined
    const ms = numeric < EPOCH_SECONDS_CEILING ? numeric * 1000 : numeric
    const fromEpoch = new Date(ms)
    return Number.isNaN(fromEpoch.getTime()) ? undefined : fromEpoch.toISOString()
  }

  const source = trimmed || String(createdAt)
  if (!ISO_DATE.test(source)) return undefined
  const parsed = new Date(
    NAIVE_DATETIME.test(source) ? `${source.replace(" ", "T")}Z` : source,
  )
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
}
