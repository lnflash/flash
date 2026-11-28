/**
 * POS USDT Live Activity outbox worker. A long-running process of its own,
 * apart from the API: it asks the checkout service for a followed receipt's
 * status (followedStatus: the POS status poll's own verified read-back), sends
 * APNs *sandbox* pushes, and writes delivery state to the live update
 * collection only.
 *
 * Does nothing and exits 0 unless the live update configuration is complete
 * (src/services/pos-usdt-checkout/live.ts). Not deployed by any chart yet.
 *
 * Run: node lib/servers/pos-usdt-live-worker.js  (same config as the API)
 */

import { flashLiveWorker } from "@services/pos-usdt-checkout/live"
import { baseLogger } from "@services/logger"
import { setupMongoConnection } from "@services/mongodb"

import { sleep } from "@utils"

const logger = baseLogger.child({ module: "pos-usdt-live-worker" })

const IDLE_MS = 500
const ERROR_MS = 5_000

export async function runPosUsdtLiveWorker(signal: { stopped: boolean }) {
  const worker = flashLiveWorker()
  if (!worker.ok) {
    logger.info({ reason: worker.reason }, "POS USDT live updates are off; worker idle")
    return 0
  }
  const mongoose = await setupMongoConnection()
  logger.info("POS USDT live update worker started (APNs sandbox)")
  try {
    while (!signal.stopped) {
      try {
        const totals = await worker.service.runDue(worker.transport)
        if (totals.pushed || totals.failed || totals.errors)
          logger.info({ totals }, "POS USDT live update pass")
        if (!totals.receipts) await sleep(IDLE_MS)
      } catch (error) {
        // Store unreachable and the like. Nothing is lost: due work stays due.
        logger.warn(
          { errorName: (error as Error)?.name },
          "POS USDT live update pass failed",
        )
        await sleep(ERROR_MS)
      }
    }
  } finally {
    worker.transport.close()
    await mongoose.connection.close()
  }
  return 0
}

if (require.main === module) {
  const signal = { stopped: false }
  for (const event of ["SIGTERM", "SIGINT"])
    process.on(event, () => {
      signal.stopped = true
    })
  runPosUsdtLiveWorker(signal)
    .then((code) => process.exit(code))
    .catch(() => {
      logger.error("POS USDT live update worker could not start")
      process.exit(1)
    })
}
