import { FygaroConfig } from "@config"
import { baseLogger } from "@services/logger"
import { redis } from "@services/redis"

import { checkFygaroTreasuryFloat } from "./float-monitor"
import { retryStrandedFygaroCredits } from "./stranded-credit-sweep"

/**
 * Treasury loop: float check + stranded-credit sweep on a fixed cadence
 * inside the long-running fygaro-webhook workload.
 *
 * Why here and not only in the cron server: the cron is a one-shot k8s Job
 * whose schedule is owned by the chart (in production it ran daily at 02:00),
 * so this repo cannot promise any cadence through it. The webhook pod is the
 * one process that is guaranteed up whenever auto-credit is live, so the
 * cadence lives here. The cron keeps calling the float check too; both paths
 * dedup through the same Redis markers.
 *
 * Replica-safe: one Redis NX lease per interval. The replica that wins runs;
 * the others skip that tick. Lease TTL is just under the interval so a tick
 * is never skipped on the next round because the previous lease is still
 * held, and a crashed holder frees it by expiry.
 */
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000
const MIN_INTERVAL_MS = 60 * 1000
const LEASE_KEY = "fygaro:treasury-loop:lease"
const FIRST_RUN_DELAY_MS = 30 * 1000

const claimLease = async (ttlSeconds: number): Promise<boolean> => {
  try {
    const set = await redis.set(LEASE_KEY, "1", "EX", ttlSeconds, "NX")
    return set === "OK"
  } catch (err) {
    // Fail-open: a Redis blip must not silence the float check. Worst case
    // two replicas both run and the alert-level markers (also fail-open)
    // collapse the duplicates.
    baseLogger.warn({ err }, "Fygaro treasury loop: lease unavailable, running anyway")
    return true
  }
}

export const runFygaroTreasuryTick = async (): Promise<void> => {
  const reading = await checkFygaroTreasuryFloat()
  if (!reading) return
  // Only sweep when the float is above the critical floor: below it the very
  // next webhook credit may fail, and a sweep would just race the live traffic
  // for the last dollars. The warning tier is fine — there is runway.
  if (reading.balanceUsd < reading.criticalFloorUsd) {
    baseLogger.info(
      { balanceUsd: reading.balanceUsd, criticalFloorUsd: reading.criticalFloorUsd },
      "Fygaro treasury loop: float critical, skipping stranded-credit sweep",
    )
    return
  }
  await retryStrandedFygaroCredits({ availableUsd: reading.balanceUsd })
}

export const startFygaroTreasuryLoop = (): NodeJS.Timeout | undefined => {
  if (!FygaroConfig.enabled || !FygaroConfig.credit?.enabled) return undefined

  const intervalMs = Math.max(
    MIN_INTERVAL_MS,
    FygaroConfig.float?.checkIntervalMs ?? DEFAULT_INTERVAL_MS,
  )
  const leaseTtlSeconds = Math.max(1, Math.floor((intervalMs * 0.9) / 1000))

  const tick = async () => {
    if (!(await claimLease(leaseTtlSeconds))) return
    try {
      await runFygaroTreasuryTick()
    } catch (err) {
      baseLogger.error({ err }, "Fygaro treasury loop tick errored")
    }
  }

  // First run shortly after boot (not immediately: Mongo/IBEX clients are
  // still warming up), then on the interval. unref so the timer never keeps
  // a shutting-down process alive.
  // tick() never rejects (it catches internally); the .catch is belt-and-braces
  // so a timer callback can never surface an unhandled rejection.
  const fire = () => {
    tick().catch((err) => baseLogger.error({ err }, "Fygaro treasury loop tick rejected"))
  }
  setTimeout(fire, FIRST_RUN_DELAY_MS).unref()
  const timer = setInterval(fire, intervalMs)
  timer.unref()
  baseLogger.info({ intervalMs }, "Fygaro treasury loop started")
  return timer
}
