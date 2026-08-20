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
 * A non-numeric value is treated as a date string, and anything unparseable
 * returns undefined so the column stays empty rather than holding a fiction.
 */
const EPOCH_SECONDS_CEILING = 1e11

export const fygaroCreatedAtToIso = (
  createdAt: string | number | undefined | null,
): string | undefined => {
  if (createdAt === undefined || createdAt === null || createdAt === "") return undefined

  const numeric = typeof createdAt === "number" ? createdAt : Number(createdAt)
  if (Number.isFinite(numeric)) {
    const ms = Math.abs(numeric) < EPOCH_SECONDS_CEILING ? numeric * 1000 : numeric
    const fromEpoch = new Date(ms)
    return Number.isNaN(fromEpoch.getTime()) ? undefined : fromEpoch.toISOString()
  }

  const parsed = new Date(String(createdAt))
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
}
