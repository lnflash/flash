import { FygaroConfig } from "@config"
import { USDAmount, USDTAmount } from "@domain/shared"
import { getBalanceForWallet } from "@app/wallets/get-balance-for-wallet"
import { alertBridge, generateDedupKey } from "@services/alerts"
import { sumFygaroCreditedNetCentsLastDays } from "@services/frappe/BridgeTransferRequestWriter"
import { baseLogger } from "@services/logger"
import { redis } from "@services/redis"

import {
  FygaroCreditError,
  resolveFygaroTreasuryFundingWallet,
} from "./webhook-server/credit-topup"

/**
 * Proactive bankowner-treasury float check for Fygaro auto-credit.
 *
 * Auto-credit spends USDT out of the bankowner treasury; when it runs dry
 * every card top-up is captured but not credited (payment.ts raises a
 * per-event CRITICAL at that point, after the customer has already been
 * charged). This check reads the SAME wallet the credit path spends from
 * (shared resolver) and alerts before the well runs dry.
 *
 * Two tiers. Below `floorUsd` is a WARNING. Below `criticalFloorUsd` (the
 * largest single payment the gate will auto-credit — the point where the very
 * next top-up may fail) or under `criticalRunwayDays` of runway at the
 * trailing-7-day burn is a CRITICAL on its own dedup key and its own Redis
 * marker, so it pages even while the warning's window is open. Runway is
 * computed from ERPNext Completed rows; if that read fails the floor alerts
 * still fire with runway "unknown" — the ERP is never allowed to silence the
 * balance check.
 *
 * Runs from two places, both idempotent via the Redis NX markers below: the
 * one-shot k8s cron Job (whatever schedule the chart gives it) and the
 * long-running fygaro-webhook workload every `checkIntervalMs`
 * (treasury-loop.ts). The webhook loop exists because the cron schedule is
 * owned by the chart, not this repo, and in production it ran daily — a daily
 * $2000 warning was the only signal for seven weeks before the 2026-10-03
 * exhaustion, and nobody acted on it.
 */
const DEFAULT_FLOOR_USD = 2000
const DEFAULT_CRITICAL_FLOOR_USD = 500
const DEFAULT_CRITICAL_RUNWAY_DAYS = 3
const DEFAULT_FUND_URL = "https://erp.flashapp.me/app/system-accounts"
const BURN_WINDOW_DAYS = 7

const FLOAT_LOW_ALERT_WINDOW_SECONDS = 3600
const FLOAT_LOW_ALERT_MARKER = "fygaro:float-low:alerted"
const FLOAT_CRITICAL_ALERT_WINDOW_SECONDS = 3600
const FLOAT_CRITICAL_ALERT_MARKER = "fygaro:float-critical:alerted"

export type FygaroFloatSeverity = "ok" | "warning" | "critical"

export type FygaroFloatReading = {
  balanceUsd: number
  floorUsd: number
  criticalFloorUsd: number
  // Average net credited per day over the trailing window, or undefined when
  // the ERPNext read failed.
  dailyBurnUsd: number | undefined
  // balance / dailyBurn. undefined when burn is unknown; null when burn is 0
  // (nothing credited in the window, so the float is not shrinking).
  runwayDays: number | undefined | null
  severity: FygaroFloatSeverity
}

// Cross-run rate limit. The cron is a one-shot Job and the webhook loop may
// run on several replicas, so the dedup has to live in Redis, not in memory.
// Fail-open: if Redis is down the alert still fires — a missed page is worse
// than a duplicate one.
const claimAlertSlot = async (
  marker: string,
  windowSeconds: number,
): Promise<boolean> => {
  try {
    const set = await redis.set(marker, "1", "EX", windowSeconds, "NX")
    return set === "OK"
  } catch (err) {
    baseLogger.warn(
      { err, marker },
      "Fygaro float check: dedup marker unavailable, alerting anyway",
    )
    return true
  }
}

// Fail-open to "unknown": the ERP is an input to the runway figure, never a
// gate on the balance alert. Catches as well as checks, so a throwing client
// cannot take the whole check down with it.
const readDailyBurnUsd = async (): Promise<number | undefined> => {
  try {
    const netCents = await sumFygaroCreditedNetCentsLastDays({ days: BURN_WINDOW_DAYS })
    if (netCents instanceof Error) {
      baseLogger.warn(
        { err: netCents },
        "Fygaro float check: could not read trailing burn from ERPNext; runway unknown",
      )
      return undefined
    }
    return netCents / 100 / BURN_WINDOW_DAYS
  } catch (err) {
    baseLogger.warn(
      { err },
      "Fygaro float check: trailing burn read threw; runway unknown",
    )
    return undefined
  }
}

export const computeRunwayDays = (
  balanceUsd: number,
  dailyBurnUsd: number | undefined,
): number | undefined | null => {
  if (dailyBurnUsd === undefined) return undefined
  if (dailyBurnUsd <= 0) return null
  return balanceUsd / dailyBurnUsd
}

export const classifyFloat = ({
  balanceUsd,
  floorUsd,
  criticalFloorUsd,
  criticalRunwayDays,
  runwayDays,
}: {
  balanceUsd: number
  floorUsd: number
  criticalFloorUsd: number
  criticalRunwayDays: number
  runwayDays: number | undefined | null
}): FygaroFloatSeverity => {
  if (balanceUsd < criticalFloorUsd) return "critical"
  if (typeof runwayDays === "number" && runwayDays < criticalRunwayDays) return "critical"
  if (balanceUsd < floorUsd) return "warning"
  return "ok"
}

const fmtUsd = (n: number): string => `$${n.toFixed(2)}`
const fmtRunway = (runwayDays: number | undefined | null): string =>
  runwayDays === undefined
    ? "unknown"
    : runwayDays === null
      ? "n/a (no credits in 7d)"
      : `${runwayDays.toFixed(1)} days`

/**
 * Reads the treasury float, alerts by tier, and returns the reading so a
 * caller (the treasury loop) can decide whether to sweep stranded credits.
 * Returns undefined when the check could not run (feature off, wallet
 * unresolvable, balance unreadable). Never throws.
 */
export const checkFygaroTreasuryFloat = async (): Promise<
  FygaroFloatReading | undefined
> => {
  if (!FygaroConfig.enabled || !FygaroConfig.credit?.enabled) return undefined

  const floorUsd = FygaroConfig.float?.floorUsd ?? DEFAULT_FLOOR_USD
  const criticalFloorUsd =
    FygaroConfig.float?.criticalFloorUsd ?? DEFAULT_CRITICAL_FLOOR_USD
  const criticalRunwayDays =
    FygaroConfig.float?.criticalRunwayDays ?? DEFAULT_CRITICAL_RUNWAY_DAYS
  const fundUrl = FygaroConfig.float?.fundUrl ?? DEFAULT_FUND_URL

  try {
    const funding = await resolveFygaroTreasuryFundingWallet()
    if (funding instanceof FygaroCreditError) {
      baseLogger.error(
        { step: funding.step, detail: funding.message },
        "Fygaro float check: could not resolve the bankowner treasury funding wallet",
      )
      return undefined
    }

    const fundingWallet = funding.fundingWallet
    const balance = await getBalanceForWallet({
      walletId: fundingWallet.id,
      currency: fundingWallet.currency,
    })

    if (balance instanceof Error) {
      baseLogger.error(
        { err: balance },
        "Fygaro float check: could not read bankowner treasury balance",
      )
      return undefined
    }

    const balanceUsd =
      balance instanceof USDTAmount
        ? Number(balance.asNumber())
        : balance instanceof USDAmount
          ? Number(balance.asDollars())
          : 0

    // Burn is read on EVERY tick. The runway tier exists for the case where
    // the balance looks healthy against the floor but is being drained fast
    // (schema.ts promises critical on short runway "regardless of the absolute
    // balance"); gating this read on nearness to the floor made that tier dead
    // exactly when burn was high. One ERPNext list query per interval.
    const dailyBurnUsd = await readDailyBurnUsd()
    const runwayDays = computeRunwayDays(balanceUsd, dailyBurnUsd)
    const severity = classifyFloat({
      balanceUsd,
      floorUsd,
      criticalFloorUsd,
      criticalRunwayDays,
      runwayDays,
    })

    const reading: FygaroFloatReading = {
      balanceUsd,
      floorUsd,
      criticalFloorUsd,
      dailyBurnUsd,
      runwayDays,
      severity,
    }

    if (severity === "ok") return reading

    baseLogger.warn(
      { balanceUsd, floorUsd, criticalFloorUsd, dailyBurnUsd, runwayDays, severity },
      "Fygaro treasury float below threshold",
    )

    const detail = [
      `balance=${fmtUsd(balanceUsd)}`,
      `floor=${fmtUsd(floorUsd)}`,
      `critical_floor=${fmtUsd(criticalFloorUsd)}`,
      `daily_burn=${dailyBurnUsd === undefined ? "unknown" : fmtUsd(dailyBurnUsd)}`,
      `runway=${fmtRunway(runwayDays)}`,
      `fund: ${fundUrl}`,
    ].join(" ")
    const context = {
      balance_usd: balanceUsd,
      floor_usd: floorUsd,
      critical_floor_usd: criticalFloorUsd,
      daily_burn_usd: dailyBurnUsd ?? null,
      runway_days: runwayDays ?? null,
      fund_url: fundUrl,
    }

    if (severity === "critical") {
      if (
        await claimAlertSlot(
          FLOAT_CRITICAL_ALERT_MARKER,
          FLOAT_CRITICAL_ALERT_WINDOW_SECONDS,
        )
      ) {
        alertBridge({
          dedupKey: generateDedupKey.fygaroFloatCritical(),
          source: "fygaro-webhook",
          severity: "critical",
          title:
            "Fygaro treasury float CRITICAL — next card top-up may fail, fund bankowner now",
          detail,
          context,
        })
      }
      return reading
    }

    if (await claimAlertSlot(FLOAT_LOW_ALERT_MARKER, FLOAT_LOW_ALERT_WINDOW_SECONDS)) {
      alertBridge({
        dedupKey: generateDedupKey.fygaroFloatLow(),
        source: "fygaro-webhook",
        severity: "warning",
        title: "Fygaro treasury float low — top up bankowner",
        detail,
        context,
      })
    }
    return reading
  } catch (err) {
    baseLogger.error({ err }, "Fygaro float check errored")
    return undefined
  }
}
