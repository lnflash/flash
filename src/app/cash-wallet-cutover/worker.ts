import { decodeInvoice } from "@domain/bitcoin/lightning"

import { assertCanTransition } from "./state-machine"
import { usdCentsToUsdtMicros, usdtMicrosToUsdCentsCeil } from "./amount-conversion"
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
  createNoAmountInvoice(args: {
    recipientWalletId: WalletId
    memo: string
  }): Promise<LnInvoice | ApplicationError>
}

type CashWalletMigrationNoAmountInvoiceService = {
  createNoAmountInvoice(args: {
    recipientWalletId: WalletId
    memo: string
  }): Promise<LnInvoice | ApplicationError>
}

type CashWalletMigrationPaymentService = {
  payInvoice(args: {
    senderWalletId: WalletId
    paymentRequest: string
    senderAmountUsdCents?: string
    senderAmountUsdtMicros?: string
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

const CUTOVER_INVOICE_PAYMENT_SAFETY_WINDOW_MS = 30 * 1000
const CUTOVER_MIN_FIXED_USDT_INVOICE_MICROS = 10_000n

const usesNoAmountFeeReimbursementInvoice = (
  feeAmountUsdtMicros: string,
): boolean | InvalidCashWalletCutoverAmountError => {
  if (!/^\d+$/.test(feeAmountUsdtMicros)) {
    return new InvalidCashWalletCutoverAmountError(
      `Invalid non-negative integer amount: ${feeAmountUsdtMicros}`,
    )
  }

  return BigInt(feeAmountUsdtMicros) < CUTOVER_MIN_FIXED_USDT_INVOICE_MICROS
}

// ENG-484: IBEX rejects Lightning payments below ~1 satoshi. Measured on TEST
// (2026-07-05, USDT→USDT no-amount invoices): 600 micros → 400 Bad Request,
// 650+ → paid. A 1-sat floor FLOATS with BTC price, so this margin covers it
// up to ~$250k/BTC. Fees below this are absorbed instead of reimbursed
// (≤ ¼ cent — invisible to users); fees above it still pay via the no-amount
// invoice path (which handles 1–9999 micros, e.g. the 4735-micro case below).
// Deliberately NOT tied to CUTOVER_MIN_FIXED_USDT_INVOICE_MICROS: that is an
// invoice-format constant, this is a payability floor + customer-funds policy.
export const CUTOVER_MIN_PAYABLE_USDT_MICROS = 2_500n

export const isSubMinimumFeeReimbursementAmount = (
  feeAmountUsdtMicros: string,
): boolean | InvalidCashWalletCutoverAmountError => {
  if (!/^\d+$/.test(feeAmountUsdtMicros)) {
    return new InvalidCashWalletCutoverAmountError(
      `Invalid non-negative integer amount: ${feeAmountUsdtMicros}`,
    )
  }

  return BigInt(feeAmountUsdtMicros) < CUTOVER_MIN_PAYABLE_USDT_MICROS
}

export const isInvoicePaymentRequestStale = ({
  paymentRequest,
  now,
  safetyWindowMs = CUTOVER_INVOICE_PAYMENT_SAFETY_WINDOW_MS,
}: {
  paymentRequest: string
  now: Date
  safetyWindowMs?: number
}): boolean => {
  const invoice = decodeInvoice(paymentRequest)
  if (invoice instanceof Error) return true

  return invoice.expiresAt.getTime() <= now.getTime() + safetyWindowMs
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
  destinationStartingBalanceUsdtMicros,
}: {
  migration: CashWalletMigration
  migrationsRepo: CashWalletMigrationTransitionRepository
  sourceBalanceUsdCents: string
  destinationStartingBalanceUsdtMicros: string
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
      destinationStartingBalanceUsdtMicros,
    },
  })
}

export const sendCashWalletMigrationBalanceMovePayment = async ({
  migration,
  paymentService,
  invoiceService,
  migrationsRepo,
  now = () => new Date(),
  invoicePaymentSafetyWindowMs = CUTOVER_INVOICE_PAYMENT_SAFETY_WINDOW_MS,
}: {
  migration: CashWalletMigration
  paymentService: CashWalletMigrationPaymentService
  invoiceService?: CashWalletMigrationNoAmountInvoiceService
  migrationsRepo: CashWalletMigrationTransitionRepository
  now?: () => Date
  invoicePaymentSafetyWindowMs?: number
}): Promise<CashWalletMigration | ApplicationError> => {
  const transition = assertCanTransition(migration.status, "balance_move_sending")
  if (transition instanceof Error) return transition

  if (migration.balanceMoveInvoicePaymentRequest === undefined) {
    return new InvalidCashWalletMigrationTransitionError(
      "balanceMoveInvoicePaymentRequest is required before balance move payment sending",
    )
  }

  if (migration.sourceBalanceUsdCents === undefined) {
    return new InvalidCashWalletMigrationTransitionError(
      "sourceBalanceUsdCents is required before balance move payment sending",
    )
  }

  let payableMigration = migration
  if (
    invoiceService &&
    isInvoicePaymentRequestStale({
      paymentRequest: migration.balanceMoveInvoicePaymentRequest,
      now: now(),
      safetyWindowMs: invoicePaymentSafetyWindowMs,
    })
  ) {
    const refreshedMigration = await createCashWalletMigrationBalanceMoveInvoice({
      migration,
      invoiceService,
      migrationsRepo,
    })
    if (refreshedMigration instanceof Error) return refreshedMigration
    payableMigration = refreshedMigration
  }

  if (payableMigration.balanceMoveInvoicePaymentRequest === undefined) {
    return new InvalidCashWalletMigrationTransitionError(
      "balanceMoveInvoicePaymentRequest is required before balance move payment sending",
    )
  }

  if (payableMigration.sourceBalanceUsdCents === undefined) {
    return new InvalidCashWalletMigrationTransitionError(
      "sourceBalanceUsdCents is required before balance move payment sending",
    )
  }

  const payment = await paymentService.payInvoice({
    senderWalletId: payableMigration.legacyUsdWalletId,
    paymentRequest: payableMigration.balanceMoveInvoicePaymentRequest,
    senderAmountUsdCents: payableMigration.sourceBalanceUsdCents,
  })
  if (payment instanceof Error) return payment

  return migrationsRepo.transitionMigration({
    id: payableMigration.id,
    from: payableMigration.status,
    to: "balance_move_sending",
    cutoverVersion: payableMigration.cutoverVersion,
    runId: payableMigration.runId,
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
    transactionId: migration.balanceMovePaymentTransactionId as IbexTransactionId,
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
  invoiceService: CashWalletMigrationNoAmountInvoiceService
  migrationsRepo: CashWalletMigrationTransitionRepository
}): Promise<CashWalletMigration | ApplicationError> => {
  const transition = assertCanTransition(migration.status, "invoice_created")
  if (transition instanceof Error) return transition

  if (migration.destinationAmountUsdtMicros === undefined) {
    return new InvalidCashWalletCutoverAmountError(
      "destinationAmountUsdtMicros is required before balance move invoice creation",
    )
  }

  const invoice = await invoiceService.createNoAmountInvoice({
    recipientWalletId: migration.destinationUsdtWalletId,
    memo: `cwco:${migration.runId}:${migration.id}:move`,
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
  feeAmountUsdtMicros,
}: {
  migration: CashWalletMigration
  invoiceService: CashWalletMigrationInvoiceService
  migrationsRepo: CashWalletMigrationTransitionRepository
  feeAmountUsdtMicros: string
}): Promise<CashWalletMigration | ApplicationError> => {
  const feeAmountUsdCents = usdtMicrosToUsdCentsCeil(feeAmountUsdtMicros)
  if (feeAmountUsdCents instanceof Error) return feeAmountUsdCents

  const transition = assertCanTransition(
    migration.status,
    "fee_reimbursement_invoice_created",
  )
  if (transition instanceof Error) return transition

  const useNoAmountInvoice = usesNoAmountFeeReimbursementInvoice(feeAmountUsdtMicros)
  if (useNoAmountInvoice instanceof Error) return useNoAmountInvoice

  const invoiceMemo = `cwco:${migration.runId}:${migration.id}:fee`
  const invoice = useNoAmountInvoice
    ? await invoiceService.createNoAmountInvoice({
        recipientWalletId: migration.destinationUsdtWalletId,
        memo: invoiceMemo,
      })
    : await invoiceService.createInvoice({
        recipientWalletId: migration.destinationUsdtWalletId,
        amount: feeAmountUsdtMicros,
        memo: invoiceMemo,
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

export const skipCashWalletMigrationFeeReimbursement = async ({
  migration,
  migrationsRepo,
  feeAmountUsdtMicros = "0",
}: {
  migration: CashWalletMigration
  migrationsRepo: CashWalletMigrationTransitionRepository
  feeAmountUsdtMicros?: string
}): Promise<CashWalletMigration | ApplicationError> => {
  const transition = assertCanTransition(migration.status, "fee_reimbursed")
  if (transition instanceof Error) return transition

  return migrationsRepo.transitionMigration({
    id: migration.id,
    from: migration.status,
    to: "fee_reimbursed",
    cutoverVersion: migration.cutoverVersion,
    runId: migration.runId,
    patch: {
      // A skipped fee is always sub-cent, so cents are 0; the micros record
      // what was absorbed (no feeReimbursementPaymentTransactionId = unpaid).
      feeAmountUsdCents: "0",
      feeAmountUsdtMicros,
    },
  })
}

export const sendCashWalletMigrationFeeReimbursementPayment = async ({
  migration,
  treasuryWalletId,
  paymentService,
  invoiceService,
  migrationsRepo,
  now = () => new Date(),
  invoicePaymentSafetyWindowMs = CUTOVER_INVOICE_PAYMENT_SAFETY_WINDOW_MS,
}: {
  migration: CashWalletMigration
  treasuryWalletId: WalletId
  paymentService: CashWalletMigrationPaymentService
  invoiceService?: CashWalletMigrationInvoiceService
  migrationsRepo: CashWalletMigrationTransitionRepository
  now?: () => Date
  invoicePaymentSafetyWindowMs?: number
}): Promise<CashWalletMigration | ApplicationError> => {
  const transition = assertCanTransition(migration.status, "fee_reimbursement_sending")
  if (transition instanceof Error) return transition

  if (migration.feeReimbursementInvoicePaymentRequest === undefined) {
    return new InvalidCashWalletMigrationTransitionError(
      "feeReimbursementInvoicePaymentRequest is required before fee reimbursement sending",
    )
  }

  let payableMigration = migration
  if (
    invoiceService &&
    isInvoicePaymentRequestStale({
      paymentRequest: migration.feeReimbursementInvoicePaymentRequest,
      now: now(),
      safetyWindowMs: invoicePaymentSafetyWindowMs,
    })
  ) {
    if (migration.feeAmountUsdtMicros === undefined) {
      return new InvalidCashWalletMigrationTransitionError(
        "feeAmountUsdtMicros is required before fee reimbursement invoice refresh",
      )
    }

    const refreshedMigration = await createCashWalletMigrationFeeReimbursementInvoice({
      migration,
      invoiceService,
      migrationsRepo,
      feeAmountUsdtMicros: migration.feeAmountUsdtMicros,
    })
    if (refreshedMigration instanceof Error) return refreshedMigration
    payableMigration = refreshedMigration
  }

  if (payableMigration.feeReimbursementInvoicePaymentRequest === undefined) {
    return new InvalidCashWalletMigrationTransitionError(
      "feeReimbursementInvoicePaymentRequest is required before fee reimbursement sending",
    )
  }

  if (payableMigration.feeAmountUsdtMicros === undefined) {
    return new InvalidCashWalletMigrationTransitionError(
      "feeAmountUsdtMicros is required before fee reimbursement sending",
    )
  }

  const useNoAmountInvoice = usesNoAmountFeeReimbursementInvoice(
    payableMigration.feeAmountUsdtMicros,
  )
  if (useNoAmountInvoice instanceof Error) return useNoAmountInvoice

  const payment = await paymentService.payInvoice({
    senderWalletId: treasuryWalletId,
    paymentRequest: payableMigration.feeReimbursementInvoicePaymentRequest,
    senderAmountUsdtMicros: useNoAmountInvoice
      ? payableMigration.feeAmountUsdtMicros
      : undefined,
  })
  if (payment instanceof Error) return payment

  return migrationsRepo.transitionMigration({
    id: payableMigration.id,
    from: payableMigration.status,
    to: "fee_reimbursement_sending",
    cutoverVersion: payableMigration.cutoverVersion,
    runId: payableMigration.runId,
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
