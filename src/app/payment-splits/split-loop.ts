import { PaymentSplitsConfig } from "@config"

import { baseLogger } from "@services/logger"
import { redis } from "@services/redis"

import { executePendingSplits } from "./execute-pending-splits"
import { reconcileSplits } from "./reconcile-splits"
import { sweepStaleSplits } from "./sweep-stale-splits"

const logger = baseLogger.child({ module: "payment-splits-loop" })

const RECONCILE_LEASE_KEY = "payment-splits:reconcile:lease"
const FIRST_RUN_DELAY_MS = 30 * 1000

/**
 * One reconcile per reconcileIntervalMs across all replicas: a Redis NX lease
 * that expires just before the next one is due. Fail-open, like the Fygaro
 * treasury loop: a Redis blip must not silence the webhook safety net, and a
 * duplicate reconcile only re-inserts rows the unique index rejects.
 */
const claimReconcileLease = async (intervalMs: number): Promise<boolean> => {
  const ttlSeconds = Math.max(1, Math.floor((intervalMs * 0.9) / 1000))
  try {
    return (await redis.set(RECONCILE_LEASE_KEY, "1", "EX", ttlSeconds, "NX")) === "OK"
  } catch (err) {
    logger.warn(
      { err },
      "payment splits loop: reconcile lease unavailable, running anyway",
    )
    return true
  }
}

/**
 * One tick of the split loop: reconcile (when its lease is due), execute every
 * due row within the executor's time budget, then sweep rows stuck in
 * `sending`. Executor claims and sweep moves are atomic per row, so ticks on
 * several replicas never pay the same row twice.
 */
export const runPaymentSplitsTick = async ({
  now = new Date(),
  shouldStop = () => false,
}: { now?: Date; shouldStop?: () => boolean } = {}): Promise<void> => {
  if (!PaymentSplitsConfig.enabled) return

  if (
    !shouldStop() &&
    (await claimReconcileLease(PaymentSplitsConfig.reconcileIntervalMs))
  ) {
    const reconciled = await reconcileSplits({
      cadenceMs: PaymentSplitsConfig.reconcileIntervalMs,
      now,
    })
    if (reconciled instanceof Error) {
      logger.error({ err: reconciled }, "payment splits loop: reconcile failed")
    } else if (reconciled.recorded > 0 || reconciled.errors > 0) {
      logger.info({ result: reconciled }, "payment splits loop: reconcile finished")
    }
  }

  if (shouldStop()) return

  const executed = await executePendingSplits({ now, shouldStop })
  if (executed instanceof Error) {
    logger.error({ err: executed }, "payment splits loop: executor failed")
  } else if (executed.claimed > 0) {
    logger.info({ result: executed }, "payment splits loop: executor finished")
  }

  if (shouldStop()) return

  const swept = await sweepStaleSplits({ now })
  if (swept instanceof Error) {
    logger.error({ err: swept }, "payment splits loop: stale sweep failed")
  }
}

export type PaymentSplitsLoop = {
  /**
   * Stops the loop for shutdown: no further tick starts, the tick in flight
   * claims no new row, and the returned promise settles once that tick (and
   * the split send it may be in the middle of) has finished.
   */
  stop: () => Promise<void>
}

/**
 * Runs the split pipeline every loopIntervalMs inside the long-running
 * ibex-webhook workload. The galoy cron is a one-shot k8s Job whose schedule
 * the chart owns (daily at 02:00), far too slow to pay splits or to make the
 * 1/2/4/8 minute retry backoff real, and this repo cannot promise a cadence
 * through it. The webhook pod records the splits, so it is up whenever there
 * is anything to pay. The daily cron keeps a long-lookback reconcile as the
 * backstop for this loop being down.
 *
 * The caller must `await loop.stop()` on SIGTERM. A pod killed mid-send leaves
 * its row in `sending`, which the stale sweep later marks `unknown` for ops.
 */
export const startPaymentSplitsLoop = (): PaymentSplitsLoop | undefined => {
  if (!PaymentSplitsConfig.enabled) return undefined

  const intervalMs = PaymentSplitsConfig.loopIntervalMs
  let stopping = false
  let inFlight: Promise<void> | null = null
  const shouldStop = () => stopping

  // A tick that outlives the interval (a long executor drain) is not stacked
  // on: the next fire is skipped until it finishes.
  const fire = () => {
    if (stopping || inFlight) return
    inFlight = runPaymentSplitsTick({ shouldStop })
      .catch((err) => logger.error({ err }, "payment splits loop tick errored"))
      .finally(() => {
        inFlight = null
      })
  }

  const firstRun = setTimeout(fire, FIRST_RUN_DELAY_MS)
  firstRun.unref()
  const timer = setInterval(fire, intervalMs)
  timer.unref()
  logger.info({ intervalMs }, "payment splits loop started")

  const stop = async (): Promise<void> => {
    stopping = true
    clearTimeout(firstRun)
    clearInterval(timer)
    if (inFlight) await inFlight
    logger.info("payment splits loop stopped")
  }

  return { stop }
}

const SHUTDOWN_SIGNALS: NodeJS.Signals[] = ["SIGTERM", "SIGINT"]
// Below the pod's 30s termination grace period, so a send that hangs can never
// be the reason the pod is SIGKILLed instead of exiting.
const SHUTDOWN_TIMEOUT_MS = 25_000

/**
 * On SIGTERM/SIGINT, stops the loop and lets the split send in flight finish
 * (bounded by SHUTDOWN_TIMEOUT_MS), then hands the signal back so the process
 * dies the way it would have without this hook. The listeners remove
 * themselves first, so the re-raised signal is not caught again.
 */
export const stopPaymentSplitsLoopOnShutdown = (
  loop: PaymentSplitsLoop,
  { timeoutMs = SHUTDOWN_TIMEOUT_MS }: { timeoutMs?: number } = {},
): void => {
  const onSignal = (signal: NodeJS.Signals): void => {
    for (const s of SHUTDOWN_SIGNALS) process.removeListener(s, onSignal)
    logger.info({ signal }, "payment splits loop: stopping for shutdown")

    Promise.race([
      loop.stop(),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref()),
    ])
      .catch((err) => logger.error({ err }, "payment splits loop: stop failed"))
      .then(() => process.kill(process.pid, signal))
  }
  for (const s of SHUTDOWN_SIGNALS) process.on(s, onSignal)
}
