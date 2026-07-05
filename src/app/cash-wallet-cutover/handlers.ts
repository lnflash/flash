import {
  completeCashWalletMigration,
  createCashWalletMigrationBalanceMoveInvoice,
  createCashWalletMigrationFeeReimbursementInvoice,
  flipCashWalletMigrationDefaultPointer,
  isSubMinimumFeeReimbursementAmount,
  markCashWalletMigrationBalanceMoveSent,
  markCashWalletMigrationFeeReimbursed,
  provisionCashWalletMigrationDestination,
  recordCashWalletMigrationBalance,
  sendCashWalletMigrationBalanceMovePayment,
  sendCashWalletMigrationFeeReimbursementPayment,
  skipCashWalletMigrationFeeReimbursement,
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
    readDestinationBalanceUsdtMicros(
      migration: CashWalletMigration,
    ): Promise<string | ApplicationError>
  }
  invoiceService: Parameters<
    typeof createCashWalletMigrationBalanceMoveInvoice
  >[0]["invoiceService"] &
    Parameters<
      typeof createCashWalletMigrationFeeReimbursementInvoice
    >[0]["invoiceService"]
  paymentService: Parameters<
    typeof sendCashWalletMigrationBalanceMovePayment
  >[0]["paymentService"]
  balanceVerifier: Parameters<
    typeof verifyCashWalletMigrationBalanceMove
  >[0]["balanceVerifier"]
  feeService: {
    readFeeAmountUsdtMicros(
      migration: CashWalletMigration,
    ): Promise<string | ApplicationError>
  }
  treasuryService: {
    getTreasuryWalletId(): Promise<WalletId | ApplicationError>
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
    const destinationStartingBalanceUsdtMicros =
      await services.balanceReader.readDestinationBalanceUsdtMicros(migration)
    if (destinationStartingBalanceUsdtMicros instanceof Error) {
      return destinationStartingBalanceUsdtMicros
    }
    return recordCashWalletMigrationBalance({
      migration,
      migrationsRepo,
      sourceBalanceUsdCents,
      destinationStartingBalanceUsdtMicros,
    })
  },
  balance_read: (migration) => {
    if (migration.destinationAmountUsdtMicros === "0") {
      return flipCashWalletMigrationDefaultPointer({
        migration,
        migrationsRepo,
        pointerService: services.pointerService,
      })
    }

    return createCashWalletMigrationBalanceMoveInvoice({
      migration,
      migrationsRepo,
      invoiceService: services.invoiceService,
    })
  },
  invoice_created: (migration) =>
    sendCashWalletMigrationBalanceMovePayment({
      migration,
      migrationsRepo,
      paymentService: services.paymentService,
      invoiceService: services.invoiceService,
      now: services.now,
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
    const feeAmountUsdtMicros =
      await services.feeService.readFeeAmountUsdtMicros(migration)
    if (feeAmountUsdtMicros instanceof Error) return feeAmountUsdtMicros
    const subMinimum = isSubMinimumFeeReimbursementAmount(feeAmountUsdtMicros)
    if (subMinimum instanceof Error) return subMinimum
    if (subMinimum) {
      return skipCashWalletMigrationFeeReimbursement({
        migration,
        migrationsRepo,
        feeAmountUsdtMicros,
      })
    }
    return createCashWalletMigrationFeeReimbursementInvoice({
      migration,
      migrationsRepo,
      invoiceService: services.invoiceService,
      feeAmountUsdtMicros,
    })
  },
  fee_reimbursement_invoice_created: async (migration) => {
    const treasuryWalletId = await services.treasuryService.getTreasuryWalletId()
    if (treasuryWalletId instanceof Error) return treasuryWalletId
    return sendCashWalletMigrationFeeReimbursementPayment({
      migration,
      migrationsRepo,
      paymentService: services.paymentService,
      invoiceService: services.invoiceService,
      now: services.now,
      treasuryWalletId,
    })
  },
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
