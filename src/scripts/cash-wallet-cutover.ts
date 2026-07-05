#!/usr/bin/env node

import yargs from "yargs"
import { hideBin } from "yargs/helpers"

import { CashWalletCutover } from "@app"
import { addWalletIfNonexistent } from "@app/accounts"
import { setupMongoConnection } from "@services/mongodb"
import {
  AccountsRepository,
  CashWalletCutoverRepository,
  WalletsRepository,
} from "@services/mongoose"
import { baseLogger } from "@services/logger"

const args = yargs(hideBin(process.argv))
  .command("preview", "discover accounts and print the migration plan without writes")
  .command(
    "provision-usdt-wallets",
    "create missing destination USDT wallets before preparing migrations",
  )
  .command("prepare", "discover accounts and upsert migration records")
  .command("start", "mark a prepared cutover run in progress")
  .command("run-batch", "run one locked migration worker batch")
  .command("status", "print cutover config and migration counts")
  .command("complete", "mark cutover complete after all migrations finish")
  .command(
    "rollback-request",
    "pull eligible migrations into rollback_started (single account with --account-id, else whole run)",
  )
  .command("rollback-batch", "run one locked rollback worker batch")
  .command(
    "rollback-complete",
    "mark the cutover config rolled_back once no migrations remain in rollback_started",
  )
  .demandCommand(1)
  .option("cutover-version", { type: "number", demandOption: true })
  .option("run-id", { type: "string", demandOption: true })
  .option("operator", { type: "string", default: "unknown" })
  .option("worker-id", { type: "string", default: `worker-${process.pid}` })
  .option("limit", { type: "number", default: 25 })
  // ENG-483: default throttle ≈30 accounts/min — the empirically safe IBEX
  // rate from the ENG-461 rehearsal (0 = unthrottled mass-failed 233 accounts
  // on 429s). Pass --step-delay-ms 0 explicitly to disable.
  .option("step-delay-ms", { type: "number", default: 2_000 })
  .option("provision-limit", { type: "number" })
  .option("provision-delay-ms", { type: "number", default: 12_500 })
  .option("provision-retry-delay-ms", { type: "number", default: 60_000 })
  .option("max-provision-attempts", { type: "number", default: 5 })
  .option("dry-run", { type: "boolean", default: false })
  .option("account-id", { type: "string" })
  .option("reason", { type: "string", default: "" })
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
    case "preview": {
      const result = await CashWalletCutover.previewPrimaryCashWalletCutover({
        cutoverVersion,
        runId,
      })
      if (result instanceof Error) throw result
      toJson(result)
      return
    }

    case "provision-usdt-wallets": {
      const result = await CashWalletCutover.provisionPrimaryCashWalletUsdtWallets({
        cutoverVersion,
        runId,
        accountsRepo: AccountsRepository(),
        walletsRepo: WalletsRepository(),
        migrationsRepo: repository,
        addWalletIfNonexistent,
        provisionLimit: args["provision-limit"],
        provisionDelayMs: args["provision-delay-ms"],
        provisionRetryDelayMs: args["provision-retry-delay-ms"],
        maxProvisionAttempts: args["max-provision-attempts"],
        dryRun: args["dry-run"],
      })
      if (result instanceof Error) throw result
      toJson(result)
      if (result.failed.length > 0) {
        throw new Error(
          `Failed to provision ${result.failed.length} destination USDT wallet(s)`,
        )
      }
      return
    }

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
        stepDelayMs: args["step-delay-ms"],
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

    case "rollback-request": {
      if (!args.reason) {
        throw new Error("--reason is required for rollback-request")
      }
      const result = await CashWalletCutover.requestPrimaryCashWalletRollback({
        cutoverVersion,
        runId,
        accountId: args["account-id"] as AccountId | undefined,
        reason: args.reason,
        requestedBy: args.operator,
        dryRun: args["dry-run"],
        migrationsRepo: repository,
      })
      if (result instanceof Error) throw result
      toJson(result)
      return
    }

    case "rollback-batch": {
      const result = await CashWalletCutover.runPrimaryCashWalletRollbackBatch({
        cutoverVersion,
        runId,
        workerId: args["worker-id"],
        limit: args.limit,
        stepDelayMs: args["step-delay-ms"],
        lockStaleBefore: new Date(Date.now() - args["lock-stale-seconds"] * 1000),
        migrationsRepo: repository,
      })
      if (result instanceof Error) throw result
      toJson(result)
      return
    }

    case "rollback-complete": {
      const result = await CashWalletCutover.completePrimaryCashWalletRollback({
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
