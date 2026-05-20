#!/usr/bin/env node

import yargs from "yargs"
import { hideBin } from "yargs/helpers"

import { CashWalletCutover } from "@app"
import { setupMongoConnection } from "@services/mongodb"
import {
  AccountsRepository,
  CashWalletCutoverRepository,
  WalletsRepository,
} from "@services/mongoose"
import { baseLogger } from "@services/logger"

const args = yargs(hideBin(process.argv))
  .command("prepare", "discover accounts and upsert migration records")
  .command("start", "mark a prepared cutover run in progress")
  .command("run-batch", "run one locked migration worker batch")
  .command("status", "print cutover config and migration counts")
  .command("complete", "mark cutover complete after all migrations finish")
  .demandCommand(1)
  .option("cutover-version", { type: "number", demandOption: true })
  .option("run-id", { type: "string", demandOption: true })
  .option("operator", { type: "string", default: "unknown" })
  .option("worker-id", { type: "string", default: `worker-${process.pid}` })
  .option("limit", { type: "number", default: 25 })
  .option("lock-stale-seconds", { type: "number", default: 300 })
  .option("configPath", { type: "string", demandOption: true })
  .parseSync()

const repository = CashWalletCutoverRepository()

const toJson = (result: unknown) => {
  console.log(JSON.stringify(result, null, 2))
}

const run = async () => {
  const command = args._[0]
  const cutoverVersion = args["cutover-version"]
  const runId = args["run-id"]

  switch (command) {
    case "prepare": {
      const result = await CashWalletCutover.preparePrimaryCashWalletCutover({
        cutoverVersion,
        runId,
        accountsRepo: AccountsRepository(),
        walletsRepo: WalletsRepository(),
        migrationsRepo: repository,
      })
      if (result instanceof Error) throw result
      toJson(result)
      return
    }

    case "start": {
      const result = await CashWalletCutover.startPrimaryCashWalletCutover({
        cutoverVersion,
        runId,
        actor: args.operator,
        migrationsRepo: repository,
      })
      if (result instanceof Error) throw result
      toJson(result)
      return
    }

    case "run-batch": {
      const result = await CashWalletCutover.runPrimaryCashWalletCutoverBatch({
        cutoverVersion,
        runId,
        workerId: args["worker-id"],
        limit: args.limit,
        lockStaleBefore: new Date(Date.now() - args["lock-stale-seconds"] * 1000),
        migrationsRepo: repository,
      })
      if (result instanceof Error) throw result
      toJson(result)
      return
    }

    case "status": {
      const result = await CashWalletCutover.getPrimaryCashWalletCutoverStatus({
        cutoverVersion,
        runId,
        migrationsRepo: repository,
      })
      if (result instanceof Error) throw result
      toJson(result)
      return
    }

    case "complete": {
      const result = await CashWalletCutover.completePrimaryCashWalletCutover({
        cutoverVersion,
        runId,
        actor: args.operator,
        migrationsRepo: repository,
      })
      if (result instanceof Error) throw result
      toJson(result)
      return
    }

    default:
      throw new Error(`Unsupported cash wallet cutover command: ${command}`)
  }
}

setupMongoConnection()
  .then(async (mongoose) => {
    await run()
    await mongoose?.connection.close()
    process.exit(0)
  })
  .catch((error) => {
    baseLogger.error({ error }, "Cash wallet cutover operator command failed")
    process.exit(1)
  })
