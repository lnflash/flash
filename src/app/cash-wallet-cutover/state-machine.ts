import { InvalidCashWalletMigrationTransitionError } from "./errors"

// Every status an operator may pull into rollback (ENG-401). Excluded by
// design: `skipped_already_migrated` (those accounts were already on USDT
// before the run and must be left there), `rollback_started` (already in
// rollback), and `rolled_back` (terminal). Pre-money statuses are included so
// a full-run rollback can uniformly cancel them — the rollback handler
// detects that no funds moved and short-circuits straight to `rolled_back`.
export const ROLLBACKABLE_STATUSES: CashWalletMigrationStatus[] = [
  "not_started",
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
  "legacy_zero_verified",
  "complete",
  "failed",
  "requires_operator_review",
]

const transitions: Partial<
  Record<CashWalletMigrationStatus, CashWalletMigrationStatus[]>
> = {
  not_started: ["started", "rollback_started"],
  started: ["provisioned", "failed", "rollback_started"],
  provisioned: ["balance_read", "failed", "skipped_already_migrated", "rollback_started"],
  balance_read: ["invoice_created", "pointer_flipped", "failed", "rollback_started"],
  invoice_created: [
    "invoice_created",
    "balance_move_sending",
    "failed",
    "requires_operator_review",
    "rollback_started",
  ],
  balance_move_sending: [
    "balance_move_sent",
    "failed",
    "requires_operator_review",
    "rollback_started",
  ],
  balance_move_sent: [
    "balance_move_verified",
    "failed",
    "requires_operator_review",
    "rollback_started",
  ],
  balance_move_verified: [
    "fee_reimbursement_invoice_created",
    "fee_reimbursed",
    "failed",
    "requires_operator_review",
    "rollback_started",
  ],
  fee_reimbursement_invoice_created: [
    "fee_reimbursement_invoice_created",
    "fee_reimbursement_sending",
    "failed",
    "requires_operator_review",
    "rollback_started",
  ],
  fee_reimbursement_sending: [
    "fee_reimbursed",
    "failed",
    "requires_operator_review",
    "rollback_started",
  ],
  fee_reimbursed: ["pointer_flipped", "failed", "rollback_started"],
  pointer_flipped: ["legacy_zero_verified", "failed", "rollback_started"],
  legacy_zero_verified: ["complete", "failed", "rollback_started"],
  complete: ["rollback_started"],
  // Operator retry (ENG-484). NOTE: `failed` CAN hold money-moved migrations —
  // a failure during legacy_zero_verified (balance moved AND pointer flipped)
  // routes to `failed` because that status is not in the runner's
  // AMBIGUOUS_SIDE_EFFECT_STATUSES (kept that way deliberately: those
  // failures are usually transient verify reads and stay auto-retryable).
  // These edges are only safe behind retry-failed's guards: skip any
  // migration with a recorded payment transaction id, and resume at
  // `pointer_flipped` (never `not_started`) when previousDefaultWalletId
  // is set.
  failed: ["rollback_started", "not_started", "pointer_flipped"],
  requires_operator_review: ["rollback_started"],
  // Self-loop persists sub-step artifacts (invoice/payment ids) mid-rollback,
  // mirroring invoice_created's refresh self-loop. Rollback failures always
  // fail closed into operator review — a rollback that dies mid-flight has
  // ambiguous side effects by definition.
  rollback_started: [
    "rollback_started",
    "rolled_back",
    "failed",
    "requires_operator_review",
  ],
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
