#!/usr/bin/env node

import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { setupMongoConnection } from "@services/mongodb"
import { baseLogger } from "@services/logger"
import { reconcileBridgeAndIbexDeposits } from "@services/bridge/reconciliation"

const args = yargs(hideBin(process.argv))
  .option("window-hours", {
    type: "number",
    default: 0.25,
    describe: "Reconciliation window in hours (default: 15 minutes)",
  })
  .option("configPath", { type: "string", demandOption: true })
  .parseSync()

const main = async () => {
  const windowMs = args["window-hours"] * 60 * 60 * 1000
  const result = await reconcileBridgeAndIbexDeposits({ windowMs })
  if (result instanceof Error) throw result
  baseLogger.info(result, "Bridge↔IBEX reconciliation finished")
}

setupMongoConnection()
  .then(async (mongoose) => {
    await main()
    await mongoose?.connection.close()
    process.exit(0)
  })
  .catch((error) => {
    baseLogger.error({ error }, "Bridge↔IBEX reconciliation failed")
    process.exit(1)
  })
