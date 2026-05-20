import { assertCanTransition } from "./state-machine"
import { feeUsdCentsToUsdtMicros, usdCentsToUsdtMicros } from "./amount-conversion"
import {
  InvalidCashWalletCutoverAmountError,
  InvalidCashWalletMigrationTransitionError,
} from "./errors"

type CashWalletMigrationTransitionRepository = {
  transitionMigration(args: {
    id: string
    from: CashWalletMigrationStatus
    to: CashWalletMigrationStatus
    cutoverVersion: number
    runId: string
    patch?: Partial<CashWalletMigration>
  }): Promise<CashWalletMigration | RepositoryError>
}

type CashWalletMigrationInvoiceService = {
  createInvoice(args: {
    recipientWalletId: WalletId
    amount: string
    memo: string
  }): Promise<LnInvoice | ApplicationError>
}

type CashWalletMigrationPaymentService = {
  payInvoice(args: {
    senderWalletId: WalletId
    paymentRequest: string
  }): Promise<{ transactionId: IbexTransactionId } | ApplicationError>
}

type CashWalletMigrationBalanceVerifier = {
  verifyBalanceMove(args: {
    legacyUsdWalletId: WalletId
    destinationUsdtWalletId: WalletId
    sourceBalanceUsdCents?: string
    destinationAmountUsdtMicros?: string
    transactionId: IbexTransactionId
  }): Promise<true | ApplicationError>
}

type CashWalletMigrationPointerService = {
  flipDefaultWallet(args: {
    accountId: AccountId
    destinationWalletId: WalletId
  }): Promise<{ previousDefaultWalletId: WalletId } | ApplicationError>
}

type CashWalletMigrationLegacyWalletVerifier = {
  verifyLegacyWalletZero(args: {
    legacyUsdWalletId: WalletId
  }): Promise<true | ApplicationError>
}

type CashWalletMigrationProvisioningService = {
  ensureDestinationWallet(args: {
    accountId: AccountId
    destinationUsdtWalletId: WalletId
  }): Promise<true | ApplicationError>
}

export const startCashWalletMigration = async ({
  migration,
  migrationsRepo,
  startedAt,
}: {
  migration: CashWalletMigration
  migrationsRepo: CashWalletMigrationTransitionRepository
  startedAt: Date
}): Promise<CashWalletMigration | ApplicationError> => {
  const transition = assertCanTransition(migration.status, "started")
  if (transition instanceof Error) return transition

  return migrationsRepo.transitionMigration({
    id: migration.id,
    from: migration.status,
    to: "started",
    cutoverVersion: migration.cutoverVersion,
    runId: migration.runId,
    patch: { startedAt },
  })
}

export const provisionCashWalletMigrationDestination = async ({
  migration,
  provisioningService,
  migrationsRepo,
}: {
  migration: CashWalletMigration
  provisioningService: CashWalletMigrationProvisioningService
  migrationsRepo: CashWalletMigrationTransitionRepository
}): Promise<CashWalletMigration | ApplicationError> => {
  const transition = assertCanTransition(migration.status, "provisioned")
  if (transition instanceof Error) return transition

  const provisioned = await provisioningService.ensureDestinationWallet({
    accountId: migration.accountId,
    destinationUsdtWalletId: migration.destinationUsdtWalletId,
  })
  if (provisioned instanceof Error) return provisioned

  return migrationsRepo.transitionMigration({
    id: migration.id,
    from: migration.status,
    to: "provisioned",
    cutoverVersion: migration.cutoverVersion,
    runId: migration.runId,
  })
}

export const recordCashWalletMigrationBalance = async ({
  migration,
  migrationsRepo,
  sourceBalanceUsdCents,
}: {
  migration: CashWalletMigration
  migrationsRepo: CashWalletMigrationTransitionRepository
  sourceBalanceUsdCents: string
}): Promise<CashWalletMigration | ApplicationError> => {
  const destinationAmountUsdtMicros = usdCentsToUsdtMicros(sourceBalanceUsdCents)
  if (destinationAmountUsdtMicros instanceof Error) return destinationAmountUsdtMicros

  const transition = assertCanTransition(migration.status, "balance_read")
  if (transition instanceof Error) return transition

  return migrationsRepo.transitionMigration({
    id: migration.id,
    from: migration.status,
    to: "balance_read",
    cutoverVersion: migration.cutoverVersion,
    runId: migration.runId,
    patch: {
      sourceBalanceUsdCents,
      destinationAmountUsdtMicros,
    },
  })
}

export const sendCashWalletMigrationBalanceMovePayment = async ({
  migration,
  paymentService,
  migrationsRepo,
}: {
  migration: CashWalletMigration
  paymentService: CashWalletMigrationPaymentService
  migrationsRepo: CashWalletMigrationTransitionRepository
}): Promise<CashWalletMigration | ApplicationError> => {
  const transition = assertCanTransition(migration.status, "balance_move_sending")
  if (transition instanceof Error) return transition

  if (migration.balanceMoveInvoicePaymentRequest === undefined) {
    return new InvalidCashWalletMigrationTransitionError(
      "balanceMoveInvoicePaymentRequest is required before balance move payment sending",
    )
  }

  const payment = await paymentService.payInvoice({
    senderWalletId: migration.legacyUsdWalletId,
    paymentRequest: migration.balanceMoveInvoicePaymentRequest,
  })
  if (payment instanceof Error) return payment

  return migrationsRepo.transitionMigration({
    id: migration.id,
    from: migration.status,
    to: "balance_move_sending",
    cutoverVersion: migration.cutoverVersion,
    runId: migration.runId,
    patch: {
      balanceMovePaymentTransactionId: payment.transactionId,
    },
  })
}

export const markCashWalletMigrationBalanceMoveSent = async ({
  migration,
  migrationsRepo,
}: {
  migration: CashWalletMigration
  migrationsRepo: CashWalletMigrationTransitionRepository
}): Promise<CashWalletMigration | ApplicationError> => {
  const transition = assertCanTransition(migration.status, "balance_move_sent")
  if (transition instanceof Error) return transition

  if (migration.balanceMovePaymentTransactionId === undefined) {
    return new InvalidCashWalletMigrationTransitionError(
      "balanceMovePaymentTransactionId is required before marking balance move sent",
    )
  }

  return migrationsRepo.transitionMigration({
    id: migration.id,
    from: migration.status,
    to: "balance_move_sent",
    cutoverVersion: migration.cutoverVersion,
    runId: migration.runId,
  })
}

export const verifyCashWalletMigrationBalanceMove = async ({
  migration,
  balanceVerifier,
  migrationsRepo,
}: {
  migration: CashWalletMigration
  balanceVerifier: CashWalletMigrationBalanceVerifier
  migrationsRepo: CashWalletMigrationTransitionRepository
}): Promise<CashWalletMigration | ApplicationError> => {
  const transition = assertCanTransition(migration.status, "balance_move_verified")
  if (transition instanceof Error) return transition

  if (migration.balanceMovePaymentTransactionId === undefined) {
    return new InvalidCashWalletMigrationTransitionError(
      "balanceMovePaymentTransactionId is required before verifying balance move",
    )
  }

  const verified = await balanceVerifier.verifyBalanceMove({
    legacyUsdWalletId: migration.legacyUsdWalletId,
    destinationUsdtWalletId: migration.destinationUsdtWalletId,
    sourceBalanceUsdCents: migration.sourceBalanceUsdCents,
    destinationAmountUsdtMicros: migration.destinationAmountUsdtMicros,
    transactionId: migration.balanceMovePaymentTransactionId,
  })
  if (verified instanceof Error) return verified

  return migrationsRepo.transitionMigration({
    id: migration.id,
    from: migration.status,
    to: "balance_move_verified",
    cutoverVersion: migration.cutoverVersion,
    runId: migration.runId,
  })
}

export const createCashWalletMigrationBalanceMoveInvoice = async ({
  migration,
  invoiceService,
  migrationsRepo,
}: {
  migration: CashWalletMigration
  invoiceService: CashWalletMigrationInvoiceService
  migrationsRepo: CashWalletMigrationTransitionRepository
}): Promise<CashWalletMigration | ApplicationError> => {
  const transition = assertCanTransition(migration.status, "invoice_created")
  if (transition instanceof Error) return transition

  if (migration.destinationAmountUsdtMicros === undefined) {
    return new InvalidCashWalletCutoverAmountError(
      "destinationAmountUsdtMicros is required before balance move invoice creation",
    )
  }

  const invoice = await invoiceService.createInvoice({
    recipientWalletId: migration.destinationUsdtWalletId,
    amount: migration.destinationAmountUsdtMicros,
    memo: `cash-wallet-cutover:${migration.runId}:${migration.id}:balance-move`,
  })
  if (invoice instanceof Error) return invoice

  return migrationsRepo.transitionMigration({
    id: migration.id,
    from: migration.status,
    to: "invoice_created",
    cutoverVersion: migration.cutoverVersion,
    runId: migration.runId,
    patch: {
      balanceMoveInvoicePaymentRequest: invoice.paymentRequest,
      balanceMoveInvoicePaymentHash: invoice.paymentHash,
    },
  })
}

export const createCashWalletMigrationFeeReimbursementInvoice = async ({
  migration,
  invoiceService,
  migrationsRepo,
  feeAmountUsdCents,
}: {
  migration: CashWalletMigration
  invoiceService: CashWalletMigrationInvoiceService
  migrationsRepo: CashWalletMigrationTransitionRepository
  feeAmountUsdCents: string
}): Promise<CashWalletMigration | ApplicationError> => {
  const feeAmountUsdtMicros = feeUsdCentsToUsdtMicros(feeAmountUsdCents)
  if (feeAmountUsdtMicros instanceof Error) return feeAmountUsdtMicros

  const transition = assertCanTransition(
    migration.status,
    "fee_reimbursement_invoice_created",
  )
  if (transition instanceof Error) return transition

  const invoice = await invoiceService.createInvoice({
    recipientWalletId: migration.legacyUsdWalletId,
    amount: feeAmountUsdCents,
    memo: `cash-wallet-cutover:${migration.runId}:${migration.id}:fee-reimbursement`,
  })
  if (invoice instanceof Error) return invoice

  return migrationsRepo.transitionMigration({
    id: migration.id,
    from: migration.status,
    to: "fee_reimbursement_invoice_created",
    cutoverVersion: migration.cutoverVersion,
    runId: migration.runId,
    patch: {
      feeAmountUsdCents,
      feeAmountUsdtMicros,
      feeReimbursementInvoicePaymentRequest: invoice.paymentRequest,
      feeReimbursementInvoicePaymentHash: invoice.paymentHash,
    },
  })
}

export const sendCashWalletMigrationFeeReimbursementPayment = async ({
  migration,
  paymentService,
  migrationsRepo,
}: {
  migration: CashWalletMigration
  paymentService: CashWalletMigrationPaymentService
  migrationsRepo: CashWalletMigrationTransitionRepository
}): Promise<CashWalletMigration | ApplicationError> => {
  const transition = assertCanTransition(migration.status, "fee_reimbursement_sending")
  if (transition instanceof Error) return transition

  if (migration.feeReimbursementInvoicePaymentRequest === undefined) {
    return new InvalidCashWalletMigrationTransitionError(
      "feeReimbursementInvoicePaymentRequest is required before fee reimbursement sending",
    )
  }

  const payment = await paymentService.payInvoice({
    senderWalletId: migration.destinationUsdtWalletId,
    paymentRequest: migration.feeReimbursementInvoicePaymentRequest,
  })
  if (payment instanceof Error) return payment

  return migrationsRepo.transitionMigration({
    id: migration.id,
    from: migration.status,
    to: "fee_reimbursement_sending",
    cutoverVersion: migration.cutoverVersion,
    runId: migration.runId,
    patch: {
      feeReimbursementPaymentTransactionId: payment.transactionId,
    },
  })
}

export const markCashWalletMigrationFeeReimbursed = async ({
  migration,
  migrationsRepo,
}: {
  migration: CashWalletMigration
  migrationsRepo: CashWalletMigrationTransitionRepository
}): Promise<CashWalletMigration | ApplicationError> => {
  const transition = assertCanTransition(migration.status, "fee_reimbursed")
  if (transition instanceof Error) return transition

  if (migration.feeReimbursementPaymentTransactionId === undefined) {
    return new InvalidCashWalletMigrationTransitionError(
      "feeReimbursementPaymentTransactionId is required before marking fee reimbursed",
    )
  }

  return migrationsRepo.transitionMigration({
    id: migration.id,
    from: migration.status,
    to: "fee_reimbursed",
    cutoverVersion: migration.cutoverVersion,
    runId: migration.runId,
  })
}

export const flipCashWalletMigrationDefaultPointer = async ({
  migration,
  pointerService,
  migrationsRepo,
}: {
  migration: CashWalletMigration
  pointerService: CashWalletMigrationPointerService
  migrationsRepo: CashWalletMigrationTransitionRepository
}): Promise<CashWalletMigration | ApplicationError> => {
  const transition = assertCanTransition(migration.status, "pointer_flipped")
  if (transition instanceof Error) return transition

  const pointer = await pointerService.flipDefaultWallet({
    accountId: migration.accountId,
    destinationWalletId: migration.destinationUsdtWalletId,
  })
  if (pointer instanceof Error) return pointer

  return migrationsRepo.transitionMigration({
    id: migration.id,
    from: migration.status,
    to: "pointer_flipped",
    cutoverVersion: migration.cutoverVersion,
    runId: migration.runId,
    patch: {
      previousDefaultWalletId: pointer.previousDefaultWalletId,
    },
  })
}

export const verifyCashWalletMigrationLegacyZero = async ({
  migration,
  legacyWalletVerifier,
  migrationsRepo,
}: {
  migration: CashWalletMigration
  legacyWalletVerifier: CashWalletMigrationLegacyWalletVerifier
  migrationsRepo: CashWalletMigrationTransitionRepository
}): Promise<CashWalletMigration | ApplicationError> => {
  const transition = assertCanTransition(migration.status, "legacy_zero_verified")
  if (transition instanceof Error) return transition

  const verified = await legacyWalletVerifier.verifyLegacyWalletZero({
    legacyUsdWalletId: migration.legacyUsdWalletId,
  })
  if (verified instanceof Error) return verified

  return migrationsRepo.transitionMigration({
    id: migration.id,
    from: migration.status,
    to: "legacy_zero_verified",
    cutoverVersion: migration.cutoverVersion,
    runId: migration.runId,
  })
}

export const completeCashWalletMigration = async ({
  migration,
  migrationsRepo,
  completedAt,
}: {
  migration: CashWalletMigration
  migrationsRepo: CashWalletMigrationTransitionRepository
  completedAt: Date
}): Promise<CashWalletMigration | ApplicationError> => {
  const transition = assertCanTransition(migration.status, "complete")
  if (transition instanceof Error) return transition

  return migrationsRepo.transitionMigration({
    id: migration.id,
    from: migration.status,
    to: "complete",
    cutoverVersion: migration.cutoverVersion,
    runId: migration.runId,
    patch: { completedAt },
  })
}
