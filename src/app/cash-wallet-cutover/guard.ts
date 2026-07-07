import {
  CashWalletCutoverInProgressError,
  CashWalletMigrationFailedError,
} from "./errors"
import { CashWalletClientCapabilities } from "./client-capability"

export { CashWalletCutoverInProgressError, CashWalletMigrationFailedError }

export type CashWalletCutoverRoute = "legacy_usd" | "usdt"
export type CashWalletCutoverPresentation = "legacy_usd" | "legacy_usd_compat" | "usdt"

export type CashWalletCutoverDecision = {
  presentation: CashWalletCutoverPresentation
}

const ACTIVE_STATUSES: CashWalletMigrationStatus[] = [
  "started",
  "provisioned",
  "balance_read",
  "invoice_created",
  "balance_move_sending",
  "balance_move_sent",
  "balance_move_verified",
  "fee_reimbursement_invoice_created",
  "fee_reimbursement_sending",
  "fee_reimbursed",
  "pointer_flipped",
  "rollback_started",
]

export const evaluateCashWalletCutoverGuard = ({
  cutover,
  migration,
}: {
  cutover: CashWalletCutoverConfig
  migration?: CashWalletMigration | null
}): { route: CashWalletCutoverRoute } | ApplicationError => {
  if (cutover.state === "pre") return { route: "legacy_usd" }

  if (cutover.state === "complete") {
    // Single-account rollback can occur after global complete (ENG-364 mode
    // 3D): those accounts' funds are back on the legacy USD wallet and must
    // not be blanket-routed to USDT.
    if (migration?.status === "rollback_started") {
      return new CashWalletCutoverInProgressError()
    }
    if (migration?.status === "rolled_back") return { route: "legacy_usd" }
    return { route: "usdt" }
  }

  if (cutover.state === "rolled_back") {
    // Run-level rollback completion requires every migration to be
    // rolled_back or skipped_already_migrated (completePrimaryCashWalletRollback
    // enforces this), so route by where funds actually sit and fail closed
    // on anything inconsistent with a rolled-back run.
    if (
      !migration ||
      migration.status === "not_started" ||
      migration.status === "rolled_back"
    ) {
      return { route: "legacy_usd" }
    }
    if (migration.status === "skipped_already_migrated") return { route: "usdt" }
    if (migration.status === "rollback_started") {
      return new CashWalletCutoverInProgressError()
    }
    return new CashWalletMigrationFailedError()
  }

  if (!migration || migration.status === "not_started") return { route: "legacy_usd" }
  if (
    migration.status === "complete" ||
    migration.status === "skipped_already_migrated"
  ) {
    return { route: "usdt" }
  }
  if (migration.status === "failed" || migration.status === "requires_operator_review") {
    return new CashWalletMigrationFailedError()
  }
  if (ACTIVE_STATUSES.includes(migration.status)) {
    return new CashWalletCutoverInProgressError()
  }

  return { route: "legacy_usd" }
}

export const evaluateCashWalletCutoverPresentation = ({
  cutover,
  migration,
  client,
}: {
  cutover: CashWalletCutoverConfig
  migration?: CashWalletMigration | null
  client: CashWalletClientCapabilities
}): CashWalletCutoverDecision | ApplicationError => {
  const guard = evaluateCashWalletCutoverGuard({ cutover, migration })
  if (guard instanceof Error) return guard

  if (guard.route === "legacy_usd") {
    return { presentation: "legacy_usd" }
  }

  return {
    presentation: client.hasUsdtCashWalletSupport ? "usdt" : "legacy_usd_compat",
  }
}
