/**
 * Hourly Bridge watch Job (ENG-889). Two steps, each run whatever the other
 * did:
 *
 *  1. Funds requests (recalls). Bridge sends no webhook when a sender's bank
 *     recalls a deposit, so watchBridgeFundsRequests polls for recalls. It used
 *     to run once a day as a task in cron.ts; a recall can lock an account for
 *     fraud, so a day was too long to wait. Handled ids are stored in the
 *     `bridgefundsrequests` collection, so a recall pages once however many
 *     runs see it. When Bridge refuses the endpoint for this API key (401
 *     not_allowed), the step is skipped and does not fail the Job.
 *  2. Customer statuses. watchBridgeCustomerStatuses alerts ops when Bridge
 *     pauses, restricts, offboards or rejects a customer, and holds cash-outs
 *     for a restricted or offboarded one.
 *
 * Runs from its own hourly k8s CronJob (charts:
 * bridge-funds-requests-cronjob.yaml, which points at this file's built path,
 * so the name stays), with the same `-c /var/yaml/custom.yaml` config as the
 * daily one.
 *
 * Exit codes: 0 when both steps ran (or Bridge is off), FAILED_EXIT_CODE when a
 * step could not do its work (Bridge poll or store failed, or the step threw).
 * A failed action on one item (ERPNext down, a lock or hold that did not take)
 * is retried by the next run by design, so it is logged but does not fail the
 * Job.
 */

import { BridgeConfig } from "@config"

import { ErrorLevel } from "@domain/shared"
import { OperationInterruptedError } from "@domain/errors"

import { flushAlerts } from "@services/alerts"
import { watchBridgeCustomerStatuses } from "@services/bridge/customer-status-watch"
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

// Each step returns whether it failed outright. A throw counts as a failure
// and never stops the next step.
const runStep = async (name: string, step: () => Promise<boolean>): Promise<boolean> => {
  try {
    return await step()
  } catch (error) {
    logger.error({ error, step: name }, "bridge hourly watch step threw")
    return true
  }
}

const fundsRequestsStep = async (): Promise<boolean> => {
  const summary = await watchBridgeFundsRequests()
  if (summary.pollFailed) {
    // The watcher has already alerted ops; fail the Job so it shows in k8s too.
    logger.error({ summary }, "bridge funds request watch could not poll Bridge")
    return true
  }
  if (summary.notPermitted) {
    logger.info({ summary }, "bridge funds request watch skipped: not permitted")
  } else if (summary.failures > 0) {
    logger.warn({ summary }, "bridge funds request watch finished; steps left to retry")
  } else {
    logger.info({ summary }, "bridge funds request watch finished")
  }
  return false
}

const customerStatusStep = async (): Promise<boolean> => {
  const summary = await watchBridgeCustomerStatuses()
  if (summary.pollFailed) {
    logger.error({ summary }, "bridge customer status watch could not run")
    return true
  }
  if (summary.failures > 0) {
    logger.warn(
      { summary },
      "bridge customer status watch finished; changes left to retry",
    )
  } else {
    logger.info({ summary }, "bridge customer status watch finished")
  }
  return false
}

const watchBridgeHourlyJob = async (): Promise<number> => {
  const fundsFailed = await runStep("funds-requests", fundsRequestsStep)
  const customersFailed = await runStep("customer-statuses", customerStatusStep)
  return fundsFailed || customersFailed ? FAILED_EXIT_CODE : OK_EXIT_CODE
}

// Runs the watch in a span and ends that span if k8s kills the pod mid-run,
// the way cron.ts does for each of its tasks.
const runInSpan = wrapAsyncToRunInSpan({
  namespace: "cron",
  fnName: "watchBridgeHourlyJob",
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
      return await watchBridgeHourlyJob()
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
    logger.info("Bridge is disabled; skipping the hourly Bridge watch")
    return OK_EXIT_CODE
  }

  const start = new Date()
  let mongoose: Awaited<ReturnType<typeof setupMongoConnection>>
  try {
    mongoose = await setupMongoConnection()
  } catch (error) {
    logger.error({ error }, "bridge hourly watch could not connect to mongo")
    return FAILED_EXIT_CODE
  }

  let exitCode = FAILED_EXIT_CODE
  try {
    exitCode = await runInSpan()
  } catch (error) {
    logger.error({ error }, "bridge hourly watch threw")
  } finally {
    // Let pages fired during the run (e.g. a new recall) finish sending before
    // the process exits and drops them.
    await flushAlerts()
    await mongoose.connection.close()
  }

  logger.info(
    `finished watchBridgeHourlyJob in ${elapsedSinceTimestamp(start)}s (success: ${
      exitCode === OK_EXIT_CODE
    })`,
  )
  return exitCode
}

if (require.main === module) {
  runBridgeFundsRequestsCron()
    .then((exitCode) => process.exit(exitCode))
    .catch((error) => {
      logger.error({ error }, "error in the hourly bridge cron job")
      process.exit(FAILED_EXIT_CODE)
    })
}
