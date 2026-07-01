import { CashWalletCutoverRepository } from "@services/mongoose"

import { createCashWalletMigrationStepHandlers } from "./handlers"
import { createCashWalletMigrationRuntimeServices } from "./runtime-services"
import { executeCashWalletMigrationStep } from "./executor"
import { runCashWalletMigrationBatch } from "./runner"

type PrimaryCashWalletCutoverBatchRepository = Parameters<
  typeof runCashWalletMigrationBatch
>[0]["migrationsRepo"] &
  Parameters<typeof createCashWalletMigrationStepHandlers>[0]["migrationsRepo"]

type PrimaryCashWalletCutoverRuntimeServices = Parameters<
  typeof createCashWalletMigrationStepHandlers
>[0]["services"]

export const runPrimaryCashWalletCutoverBatch = ({
  cutoverVersion,
  runId,
  workerId,
  limit,
  stepDelayMs,
  lockStaleBefore,
  migrationsRepo = CashWalletCutoverRepository(),
  runtimeServices = createCashWalletMigrationRuntimeServices(),
}: {
  cutoverVersion: number
  runId: string
  workerId: string
  limit?: number
  stepDelayMs?: number
  lockStaleBefore: Date
  migrationsRepo?: PrimaryCashWalletCutoverBatchRepository
  runtimeServices?: PrimaryCashWalletCutoverRuntimeServices
}) => {
  const handlers = createCashWalletMigrationStepHandlers({
    migrationsRepo,
    services: runtimeServices,
  })

  return runCashWalletMigrationBatch({
    cutoverVersion,
    runId,
    workerId,
    limit,
    stepDelayMs,
    lockStaleBefore,
    migrationsRepo,
    executor: (migration) =>
      executeCashWalletMigrationStep({
        migration,
        handlers,
      }),
  })
}
