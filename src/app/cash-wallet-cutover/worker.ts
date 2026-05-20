import { assertCanTransition } from "./state-machine"
import { usdCentsToUsdtMicros } from "./amount-conversion"
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
