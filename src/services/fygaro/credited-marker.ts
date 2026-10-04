import { FygaroConfig } from "@config"
import { baseLogger } from "@services/logger"
import { redis } from "@services/redis"

/**
 * Durable "this Fygaro payment has been credited" marker, independent of
 * ERPNext.
 *
 * The audit row's Completed status is the processed marker both the webhook
 * and the stranded-credit sweep honour — but promoting that row is itself a
 * write that can fail AFTER the money has moved. When it does, the row keeps
 * reading Fiat Received with no failure_reason, which is exactly the shape the
 * sweep lists as "stranded" every 15 minutes for `retry.lookbackDays`. The
 * send is idempotent under withPaymentIdempotency, but that cache lives 24h
 * (src/app/payments/idempotency.ts); the sweep's lookback is 7 days. Past the
 * cache window a replay is a second real intraledger payment of the full net.
 *
 * So a credit is recorded HERE the moment the send succeeds, before any
 * announcement, with a TTL that outlives the sweep's lookback. The sweep checks
 * it (alongside the ERPNext row) before every send; a row whose promotion
 * failed is then an ops task ("promote by hand"), never a re-pay.
 *
 * Fail-open on write (a Redis blip must not fail a credit that already
 * happened) and fail-CLOSED on read for the sweep's purposes is the wrong
 * shape — an unreadable marker is reported as "unknown" and the caller
 * decides. The sweep treats unknown as "do not send": a stranded payment waits
 * one more tick, a double-pay cannot be walked back.
 */
const DEFAULT_LOOKBACK_DAYS = 7
const SECONDS_PER_DAY = 24 * 60 * 60

export const creditedMarkerKey = (transactionId: string): string =>
  `fygaro:sweep-credited:${transactionId}`

// Lookback + 1 day, so a row still inside the sweep's window can never find
// its marker expired.
export const creditedMarkerTtlSeconds = (): number => {
  const lookbackDays = FygaroConfig.retry?.lookbackDays ?? DEFAULT_LOOKBACK_DAYS
  return (lookbackDays + 1) * SECONDS_PER_DAY
}

export const markFygaroCredited = async ({
  transactionId,
  netCents,
}: {
  transactionId: string
  netCents: number
}): Promise<void> => {
  try {
    await redis.set(
      creditedMarkerKey(transactionId),
      String(netCents),
      "EX",
      creditedMarkerTtlSeconds(),
    )
  } catch (err) {
    baseLogger.warn(
      { err, transactionId },
      "Fygaro credited marker: could not write; a failed promotion on this row will not be protected from re-pay",
    )
  }
}

export type FygaroCreditedMarker =
  | { known: true; credited: boolean; netCents?: number }
  | { known: false }

export const readFygaroCreditedMarker = async (
  transactionId: string,
): Promise<FygaroCreditedMarker> => {
  try {
    const raw = await redis.get(creditedMarkerKey(transactionId))
    if (raw === null || raw === undefined) return { known: true, credited: false }
    const netCents = Number(raw)
    return {
      known: true,
      credited: true,
      netCents: Number.isFinite(netCents) && netCents > 0 ? netCents : undefined,
    }
  } catch (err) {
    baseLogger.warn(
      { err, transactionId },
      "Fygaro credited marker: could not read; treating as unknown",
    )
    return { known: false }
  }
}
