import {
  completeCashWalletMigration,
  createCashWalletMigrationBalanceMoveInvoice,
  createCashWalletMigrationFeeReimbursementInvoice,
  flipCashWalletMigrationDefaultPointer,
  markCashWalletMigrationBalanceMoveSent,
  markCashWalletMigrationFeeReimbursed,
  provisionCashWalletMigrationDestination,
  recordCashWalletMigrationBalance,
  sendCashWalletMigrationBalanceMovePayment,
  sendCashWalletMigrationFeeReimbursementPayment,
  startCashWalletMigration,
  verifyCashWalletMigrationBalanceMove,
  verifyCashWalletMigrationLegacyZero,
} from "./worker"
import { CashWalletMigrationStepHandlers } from "./executor"

type CashWalletMigrationTransitionRepository = Parameters<
  typeof startCashWalletMigration
>[0]["migrationsRepo"]

type CashWalletMigrationHandlerServices = {
  now(): Date
  provisioningService: Parameters<
    typeof provisionCashWalletMigrationDestination
  >[0]["provisioningService"]
  balanceReader: {
    readSourceBalanceUsdCents(
      migration: CashWalletMigration,
    ): Promise<string | ApplicationError>
  }
  invoiceService: Parameters<
    typeof createCashWalletMigrationBalanceMoveInvoice
  >[0]["invoiceService"]
  paymentService: Parameters<
    typeof sendCashWalletMigrationBalanceMovePayment
  >[0]["paymentService"]
  balanceVerifier: Parameters<
    typeof verifyCashWalletMigrationBalanceMove
  >[0]["balanceVerifier"]
  feeService: {
    readFeeAmountUsdCents(
      migration: CashWalletMigration,
    ): Promise<string | ApplicationError>
  }
  pointerService: Parameters<
    typeof flipCashWalletMigrationDefaultPointer
  >[0]["pointerService"]
  legacyWalletVerifier: Parameters<
    typeof verifyCashWalletMigrationLegacyZero
  >[0]["legacyWalletVerifier"]
}

export const createCashWalletMigrationStepHandlers = ({
  migrationsRepo,
  services,
}: {
  migrationsRepo: CashWalletMigrationTransitionRepository
  services: CashWalletMigrationHandlerServices
}): CashWalletMigrationStepHandlers => ({
  not_started: (migration) =>
    startCashWalletMigration({
      migration,
      migrationsRepo,
      startedAt: services.now(),
    }),
  started: (migration) =>
    provisionCashWalletMigrationDestination({
      migration,
      migrationsRepo,
      provisioningService: services.provisioningService,
    }),
  provisioned: async (migration) => {
    const sourceBalanceUsdCents =
      await services.balanceReader.readSourceBalanceUsdCents(migration)
    if (sourceBalanceUsdCents instanceof Error) return sourceBalanceUsdCents
    return recordCashWalletMigrationBalance({
      migration,
      migrationsRepo,
      sourceBalanceUsdCents,
    })
  },
  balance_read: (migration) =>
    createCashWalletMigrationBalanceMoveInvoice({
      migration,
      migrationsRepo,
      invoiceService: services.invoiceService,
    }),
  invoice_created: (migration) =>
    sendCashWalletMigrationBalanceMovePayment({
      migration,
      migrationsRepo,
      paymentService: services.paymentService,
    }),
  balance_move_sending: (migration) =>
    markCashWalletMigrationBalanceMoveSent({ migration, migrationsRepo }),
  balance_move_sent: (migration) =>
    verifyCashWalletMigrationBalanceMove({
      migration,
      migrationsRepo,
      balanceVerifier: services.balanceVerifier,
    }),
  balance_move_verified: async (migration) => {
    const feeAmountUsdCents = await services.feeService.readFeeAmountUsdCents(migration)
    if (feeAmountUsdCents instanceof Error) return feeAmountUsdCents
    return createCashWalletMigrationFeeReimbursementInvoice({
      migration,
      migrationsRepo,
      invoiceService: services.invoiceService,
      feeAmountUsdCents,
    })
  },
  fee_reimbursement_invoice_created: (migration) =>
    sendCashWalletMigrationFeeReimbursementPayment({
      migration,
      migrationsRepo,
      paymentService: services.paymentService,
    }),
  fee_reimbursement_sending: (migration) =>
    markCashWalletMigrationFeeReimbursed({ migration, migrationsRepo }),
  fee_reimbursed: (migration) =>
    flipCashWalletMigrationDefaultPointer({
      migration,
      migrationsRepo,
      pointerService: services.pointerService,
    }),
  pointer_flipped: (migration) =>
    verifyCashWalletMigrationLegacyZero({
      migration,
      migrationsRepo,
      legacyWalletVerifier: services.legacyWalletVerifier,
    }),
  legacy_zero_verified: (migration) =>
    completeCashWalletMigration({
      migration,
      migrationsRepo,
      completedAt: services.now(),
    }),
})
