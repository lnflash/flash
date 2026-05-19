type CashWalletCutoverState = "pre" | "in_progress" | "complete"

type CashWalletMigrationStatus =
  | "not_started"
  | "started"
  | "provisioned"
  | "balance_read"
  | "invoice_created"
  | "balance_move_sending"
  | "balance_move_sent"
  | "balance_move_verified"
  | "fee_reimbursement_invoice_created"
  | "fee_reimbursement_sending"
  | "fee_reimbursed"
  | "pointer_flipped"
  | "legacy_zero_verified"
  | "complete"
  | "failed"
  | "requires_operator_review"
  | "skipped_already_migrated"
  | "rollback_started"
  | "rolled_back"

type CashWalletCutoverConfig = {
  state: CashWalletCutoverState
  scheduledAt?: Date
  startedAt?: Date
  completedAt?: Date
  pausedAt?: Date
  pauseReason?: string
  updatedBy?: string
  cutoverVersion: number
  runId?: string
  updatedAt: Date
}

type CashWalletMigration = {
  id: string
  accountId: AccountId
  accountUuid?: AccountUuid
  legacyUsdWalletId: WalletId
  destinationUsdtWalletId: WalletId
  previousDefaultWalletId?: WalletId
  cutoverVersion: number
  runId: string
  status: CashWalletMigrationStatus
  sourceBalanceUsdCents?: string
  destinationAmountUsdtMicros?: string
  feeAmountUsdCents?: string
  feeAmountUsdtMicros?: string
  balanceMoveInvoicePaymentRequest?: string
  balanceMoveInvoicePaymentHash?: string
  balanceMovePaymentTransactionId?: string
  feeReimbursementInvoicePaymentRequest?: string
  feeReimbursementInvoicePaymentHash?: string
  feeReimbursementPaymentTransactionId?: string
  estimatedFee?: boolean
  idempotencyKey: string
  attempts: number
  lastError?: string
  lockedAt?: Date
  lockedBy?: string
  startedAt?: Date
  completedAt?: Date
  updatedAt: Date
}
