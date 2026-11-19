/**
 * Hourly Bridge funds request watcher (ENG-889).
 *
 * Bridge sends no webhook when a sender's bank recalls a deposit, so
 * watchBridgeFundsRequests polls for recalls. It used to run once a day as a
 * task in cron.ts; a recall can lock an account for fraud, so a day was too
 * long to wait. This entrypoint runs only the watcher, from its own hourly k8s
 * CronJob (charts: bridge-funds-requests-cronjob.yaml), with the same
 * `-c /var/yaml/custom.yaml` config as the daily one.
 *
 * Running it more often is safe: handled ids are stored in the
 * `bridgefundsrequests` collection, so a recall pages once however many runs
 * see it.
 *
 * Exit codes: 0 when the watch ran (or Bridge is off), FAILED_EXIT_CODE when
 * the poll failed or the run threw. A failed step on one request (ERPNext
 * down, a lock that did not take) is retried by the next run by design, so it
 * is logged but does not fail the Job.
 */

import { BridgeConfig } from "@config"

import { ErrorLevel } from "@domain/shared"
import { OperationInterruptedError } from "@domain/errors"

import { flushAlerts } from "@services/alerts"
import { watchBridgeFundsRequests } from "@services/bridge/funds-requests"
import { baseLogger } from "@services/logger"
import { setupMongoConnection } from "@services/mongodb"
import {
  addAttributesToCurrentSpan,
  recordExceptionInCurrentSpan,
  wrapAsyncToRunInSpan,
} from "@services/tracing"

import { elapsedSinceTimestamp, sleep } from "@utils"

const logger = baseLogger.child({ module: "bridge-funds-requests-cron" })

export const OK_EXIT_CODE = 0
// Same code cron.ts exits with when a task fails.
export const FAILED_EXIT_CODE = 99

const PROCESS_KILL_EVENTS = ["SIGTERM", "SIGINT"]

const watchBridgeFundsRequestsJob = async (): Promise<number> => {
  const summary = await watchBridgeFundsRequests()
  if (summary.pollFailed) {
    // The watcher has already alerted ops; fail the Job so it shows in k8s too.
    logger.error({ summary }, "bridge funds request watch could not poll Bridge")
    return FAILED_EXIT_CODE
  }
  if (summary.failures > 0) {
    logger.warn({ summary }, "bridge funds request watch finished; steps left to retry")
  } else {
    logger.info({ summary }, "bridge funds request watch finished")
  }
  return OK_EXIT_CODE
}

// Runs the watcher in a span and ends that span if k8s kills the pod mid-run,
// the way cron.ts does for each of its tasks.
const runInSpan = wrapAsyncToRunInSpan({
  namespace: "cron",
  fnName: "watchBridgeFundsRequestsJob",
  fn: async (): Promise<number> => {
    const start = new Date()
    const span = addAttributesToCurrentSpan({ jobCompleted: "false" })

    const signalHandler = async (eventName: string) => {
      const finishDelay = 5_000
      const elapsed = elapsedSinceTimestamp(start)
      logger.info(`Received ${eventName} signal. Finishing span...`)
      recordExceptionInCurrentSpan({
        error: new OperationInterruptedError(
          `Operation was interrupted by '${eventName}' signal after ${elapsed.toLocaleString()}s`,
        ),
        level: ErrorLevel.Critical,
        attributes: { killSignal: eventName, elapsedBeforeKillInSeconds: elapsed },
      })
      span?.end()
      await sleep(finishDelay)
      process.exit(FAILED_EXIT_CODE)
    }

    for (const event of PROCESS_KILL_EVENTS) {
      process.on(event, signalHandler)
    }
    try {
      return await watchBridgeFundsRequestsJob()
    } finally {
      for (const event of PROCESS_KILL_EVENTS) {
        process.removeListener(event, signalHandler)
      }
      addAttributesToCurrentSpan({ jobCompleted: "true" })
    }
  },
})

/**
 * One run of the hourly Job. Returns the process exit code instead of exiting,
 * so it can be driven from a unit test.
 */
export const runBridgeFundsRequestsCron = async (): Promise<number> => {
  if (!BridgeConfig.enabled) {
    logger.info("Bridge is disabled; skipping the funds request watch")
    return OK_EXIT_CODE
  }

  const start = new Date()
  let mongoose: Awaited<ReturnType<typeof setupMongoConnection>>
  try {
    mongoose = await setupMongoConnection()
  } catch (error) {
    logger.error({ error }, "bridge funds request watch could not connect to mongo")
    return FAILED_EXIT_CODE
  }

  let exitCode = FAILED_EXIT_CODE
  try {
    exitCode = await runInSpan()
  } catch (error) {
    logger.error({ error }, "bridge funds request watch threw")
  } finally {
    // Let pages fired during the run (e.g. a new recall) finish sending before
    // the process exits and drops them.
    await flushAlerts()
    await mongoose.connection.close()
  }

  logger.info(
    `finished watchBridgeFundsRequestsJob in ${elapsedSinceTimestamp(start)}s (success: ${
      exitCode === OK_EXIT_CODE
    })`,
  )
  return exitCode
}

if (require.main === module) {
  runBridgeFundsRequestsCron()
    .then((exitCode) => process.exit(exitCode))
    .catch((error) => {
      logger.error({ error }, "error in the bridge funds request cron job")
      process.exit(FAILED_EXIT_CODE)
    })
}
