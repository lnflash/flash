import { CashWalletCutoverRepository } from "@services/mongoose"

import { CashWalletMigrationFailedError } from "./errors"

type CashWalletRetryRepository = ReturnType<typeof CashWalletCutoverRepository>

export type CashWalletRetryFailedReport = {
  dryRun: boolean
  eligible: number
  retried: number
  /** Migrations skipped because money moved — those are operator-review work. */
  skippedMoneyMoved: number
  /** Lost races: migrations concurrently moved out of `failed` mid-run. */
  conflicts: number
  resumedAt: Partial<Record<CashWalletMigrationStatus, number>>
  migrationIds: string[]
}

/**
 * Re-drive `failed` migrations (ENG-484). Safe by construction: the runner
 * routes failures in money-moving statuses to `requires_operator_review`, so
 * anything sitting in `failed` has no ambiguous side effects. Resume point is
 * field-driven, mirroring the forward pipeline's guards:
 *
 * - pointer flipped (`previousDefaultWalletId` set) → resume `pointer_flipped`,
 *   preserving the recorded pointer so a later rollback stays correct
 * - otherwise → reset to `not_started`, clearing stale progress fields so the
 *   machine re-walks provisioning and balance read from scratch
 *
 * Migrations with a recorded payment transaction are never retried here —
 * defense in depth should one ever land in `failed`.
 */
export const retryFailedCashWalletMigrations = async ({
  cutoverVersion,
  runId,
  accountId,
  dryRun = false,
  migrationsRepo = CashWalletCutoverRepository(),
}: {
  cutoverVersion: number
  runId: string
  /** Single-account mode when set; all failed migrations when omitted. */
  accountId?: AccountId
  dryRun?: boolean
  migrationsRepo?: CashWalletRetryRepository
}): Promise<CashWalletRetryFailedReport | ApplicationError> => {
  let candidates: CashWalletMigration[]

  if (accountId !== undefined) {
    const migration = await migrationsRepo.findMigrationByAccountId({
      accountId,
      cutoverVersion,
      runId,
    })
    if (migration instanceof Error) return migration
    if (migration === null) {
      return new CashWalletMigrationFailedError(
        `No migration found for accountId=${accountId} runId=${runId}`,
      )
    }
    if (migration.status !== "failed") {
      return new CashWalletMigrationFailedError(
        `Migration for accountId=${accountId} is ${migration.status}, not failed`,
      )
    }
    candidates = [migration]
  } else {
    const migrations = await migrationsRepo.listMigrationsByStatuses({
      cutoverVersion,
      runId,
      statuses: ["failed"],
    })
    if (migrations instanceof Error) return migrations
    candidates = migrations
  }

  const report: CashWalletRetryFailedReport = {
    dryRun,
    eligible: 0,
    retried: 0,
    skippedMoneyMoved: 0,
    conflicts: 0,
    resumedAt: {},
    migrationIds: [],
  }

  for (const migration of candidates) {
    if (
      migration.balanceMovePaymentTransactionId !== undefined ||
      migration.feeReimbursementPaymentTransactionId !== undefined
    ) {
      report.skippedMoneyMoved += 1
      continue
    }

    const resumeStatus: CashWalletMigrationStatus =
      migration.previousDefaultWalletId !== undefined ? "pointer_flipped" : "not_started"

    report.eligible += 1
    report.migrationIds.push(migration.id)
    report.resumedAt[resumeStatus] = (report.resumedAt[resumeStatus] ?? 0) + 1
    if (dryRun) continue

    const transitioned = await migrationsRepo.transitionMigration({
      id: migration.id,
      from: "failed",
      to: resumeStatus,
      cutoverVersion,
      runId,
      patch: { attempts: 0 },
      clear:
        resumeStatus === "not_started"
          ? [
              "lastError",
              "sourceBalanceUsdCents",
              "destinationAmountUsdtMicros",
              "destinationStartingBalanceUsdtMicros",
              "feeAmountUsdCents",
              "feeAmountUsdtMicros",
              "balanceMoveInvoicePaymentRequest",
              "balanceMoveInvoicePaymentHash",
              "feeReimbursementInvoicePaymentRequest",
              "feeReimbursementInvoicePaymentHash",
            ]
          : ["lastError"],
    })
    if (transitioned instanceof Error) {
      // Lost a race (e.g. a concurrent rollback-request moved this migration
      // out of `failed` — the guarded findOneAndUpdate matched nothing).
      // Skip it and keep going: aborting would discard the report of
      // migrations already reset by earlier iterations.
      report.eligible -= 1
      report.migrationIds.pop()
      report.resumedAt[resumeStatus] = (report.resumedAt[resumeStatus] ?? 1) - 1
      report.conflicts += 1
      continue
    }
    report.retried += 1
  }

  return report
}
