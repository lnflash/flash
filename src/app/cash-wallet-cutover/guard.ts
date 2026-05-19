import {
  CashWalletCutoverInProgressError,
  CashWalletMigrationFailedError,
} from "./errors"

export { CashWalletCutoverInProgressError, CashWalletMigrationFailedError }

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
}): { route: "legacy_usd" | "eth_usdt" } | ApplicationError => {
  if (cutover.state === "pre") return { route: "legacy_usd" }
  if (cutover.state === "complete") return { route: "eth_usdt" }

  if (!migration || migration.status === "not_started") return { route: "legacy_usd" }
  if (migration.status === "complete" || migration.status === "skipped_already_migrated") {
    return { route: "eth_usdt" }
  }
  if (migration.status === "failed" || migration.status === "requires_operator_review") {
    return new CashWalletMigrationFailedError()
  }
  if (ACTIVE_STATUSES.includes(migration.status)) {
    return new CashWalletCutoverInProgressError()
  }

  return { route: "legacy_usd" }
}
