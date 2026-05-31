import { InvalidCashWalletMigrationTransitionError } from "./errors"

const transitions: Partial<
  Record<CashWalletMigrationStatus, CashWalletMigrationStatus[]>
> = {
  not_started: ["started"],
  started: ["provisioned", "failed"],
  provisioned: ["balance_read", "failed", "skipped_already_migrated"],
  balance_read: ["invoice_created", "pointer_flipped", "failed"],
  invoice_created: [
    "invoice_created",
    "balance_move_sending",
    "failed",
    "requires_operator_review",
  ],
  balance_move_sending: ["balance_move_sent", "failed", "requires_operator_review"],
  balance_move_sent: ["balance_move_verified", "failed", "requires_operator_review"],
  balance_move_verified: [
    "fee_reimbursement_invoice_created",
    "fee_reimbursed",
    "failed",
    "requires_operator_review",
  ],
  fee_reimbursement_invoice_created: [
    "fee_reimbursement_invoice_created",
    "fee_reimbursement_sending",
    "failed",
    "requires_operator_review",
  ],
  fee_reimbursement_sending: ["fee_reimbursed", "failed", "requires_operator_review"],
  fee_reimbursed: ["pointer_flipped", "failed"],
  pointer_flipped: ["legacy_zero_verified", "failed"],
  legacy_zero_verified: ["complete", "failed"],
  rollback_started: ["rolled_back", "failed"],
}

export const assertCanTransition = (
  from: CashWalletMigrationStatus,
  to: CashWalletMigrationStatus,
): true | InvalidCashWalletMigrationTransitionError => {
  if (transitions[from]?.includes(to)) return true
  return new InvalidCashWalletMigrationTransitionError(
    `Invalid migration transition: ${from} -> ${to}`,
  )
}

export const nextResumeStatus = (
  status: CashWalletMigrationStatus,
): CashWalletMigrationStatus => status
