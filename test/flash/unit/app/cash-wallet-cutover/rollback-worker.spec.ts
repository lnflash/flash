import {
  executeCashWalletMigrationRollbackStep,
  requestCashWalletMigrationRollback,
} from "@app/cash-wallet-cutover/rollback-worker"
import { legacyShortfallUsdtMicros } from "@app/cash-wallet-cutover/amount-conversion"
import { assertCanTransition } from "@app/cash-wallet-cutover/state-machine"
import {
  CashWalletMigrationFailedError,
  InvalidCashWalletMigrationTransitionError,
} from "@app/cash-wallet-cutover/errors"

const NOW = new Date("2026-07-04T00:00:00.000Z")

const baseMigration = {
  id: "migration-id",
  accountId: "account-id" as AccountId,
  legacyUsdWalletId: "legacy-wallet-id" as WalletId,
  destinationUsdtWalletId: "destination-wallet-id" as WalletId,
  cutoverVersion: 3,
  runId: "run-id",
  status: "rollback_started",
  idempotencyKey: "run-id:account-id",
  attempts: 0,
  updatedAt: NOW,
} as CashWalletMigration

const invoice = {
  paymentRequest: "lnbc1invoice" as Bolt11,
  paymentHash: "payment-hash" as PaymentHash,
}

// Stateful repo mock: patches accumulate across the executor's sub-steps the
// way the real repository behaves.
const statefulRepo = (initial: CashWalletMigration) => {
  let state = { ...initial }
  return {
    transitionMigration: jest.fn(async ({ to, patch }) => {
      state = { ...state, ...patch, status: to }
      return { ...state }
    }),
    current: () => state,
  }
}

const services = ({
  defaultWalletId = "legacy-wallet-id" as WalletId,
  usdtBalanceMicros = "0",
  spendableUsdtMicros,
  legacyBalanceUsdCents = "0",
}: {
  defaultWalletId?: WalletId
  usdtBalanceMicros?: string
  spendableUsdtMicros?: string
  legacyBalanceUsdCents?: string
} = {}) => ({
  now: () => NOW,
  accountReader: {
    getDefaultWalletId: jest.fn().mockResolvedValue(defaultWalletId),
  },
  pointerService: {
    flipDefaultWallet: jest
      .fn()
      .mockResolvedValue({ previousDefaultWalletId: "destination-wallet-id" }),
  },
  balanceReader: {
    readSourceBalanceUsdCents: jest.fn().mockResolvedValue(legacyBalanceUsdCents),
    readDestinationBalanceUsdtMicros: jest.fn().mockResolvedValue(usdtBalanceMicros),
    readDestinationSpendableUsdtMicros: jest
      .fn()
      .mockResolvedValue(spendableUsdtMicros ?? usdtBalanceMicros),
  },
  invoiceService: {
    createNoAmountInvoice: jest.fn().mockResolvedValue(invoice),
  },
  paymentService: {
    payInvoice: jest
      .fn()
      .mockResolvedValue({ transactionId: "reverse-txn-id" as IbexTransactionId }),
  },
  treasuryService: {
    getTreasuryWalletId: jest.fn().mockResolvedValue("treasury-wallet-id" as WalletId),
  },
})

describe("rollback request", () => {
  it("pulls a completed migration into rollback_started with an audit trail", async () => {
    const migration = { ...baseMigration, status: "complete" } as CashWalletMigration
    const migrationsRepo = statefulRepo(migration)

    const result = await requestCashWalletMigrationRollback({
      migration,
      migrationsRepo,
      requestedBy: "operator-1",
      reason: "reconciliation drift",
      requestedAt: NOW,
    })

    expect(result).toMatchObject({
      status: "rollback_started",
      rollbackRequestedAt: NOW,
      rollbackRequestedBy: "operator-1",
      rollbackReason: "reconciliation drift",
      rollbackFromStatus: "complete",
    })
  })

  it("rejects rollback of skipped_already_migrated accounts", async () => {
    const migration = {
      ...baseMigration,
      status: "skipped_already_migrated",
    } as CashWalletMigration

    const result = await requestCashWalletMigrationRollback({
      migration,
      migrationsRepo: statefulRepo(migration),
      requestedBy: "operator-1",
      reason: "should not happen",
      requestedAt: NOW,
    })

    expect(result).toBeInstanceOf(InvalidCashWalletMigrationTransitionError)
  })

  it("rejects rollback of already rolled_back migrations", () => {
    expect(assertCanTransition("rolled_back", "rollback_started")).toBeInstanceOf(
      InvalidCashWalletMigrationTransitionError,
    )
  })
})

describe("rollback executor", () => {
  it("refuses to run on non-rollback_started migrations", async () => {
    const result = await executeCashWalletMigrationRollbackStep({
      migration: { ...baseMigration, status: "complete" } as CashWalletMigration,
      migrationsRepo: statefulRepo(baseMigration),
      services: services(),
    })
    expect(result).toBeInstanceOf(InvalidCashWalletMigrationTransitionError)
  })

  it("short-circuits pre-money migrations straight to rolled_back", async () => {
    // Never sent a forward payment; account default never flipped.
    const migration = {
      ...baseMigration,
      rollbackFromStatus: "balance_read",
    } as CashWalletMigration
    const migrationsRepo = statefulRepo(migration)
    const svc = services()

    const result = await executeCashWalletMigrationRollbackStep({
      migration,
      migrationsRepo,
      services: svc,
    })

    expect(result).toMatchObject({ status: "rolled_back", rolledBackAt: NOW })
    expect(svc.pointerService.flipDefaultWallet).not.toHaveBeenCalled()
    expect(svc.paymentService.payInvoice).not.toHaveBeenCalled()
  })

  it("never flips the pointer for pre-money migrations, even if the account defaults to USDT", async () => {
    // No previousDefaultWalletId: the forward pipeline never flipped, so a
    // USDT default came from elsewhere (e.g. native USDT-default signup).
    const migration = { ...baseMigration }
    const svc = services({ defaultWalletId: "destination-wallet-id" as WalletId })

    const result = await executeCashWalletMigrationRollbackStep({
      migration,
      migrationsRepo: statefulRepo(migration),
      services: svc,
    })

    expect(svc.pointerService.flipDefaultWallet).not.toHaveBeenCalled()
    expect(result).toMatchObject({ status: "rolled_back" })
  })

  it("restores the default pointer when the account still defaults to USDT", async () => {
    const migration = {
      ...baseMigration,
      previousDefaultWalletId: "legacy-wallet-id" as WalletId,
    }
    const migrationsRepo = statefulRepo(migration)
    const svc = services({ defaultWalletId: "destination-wallet-id" as WalletId })

    const result = await executeCashWalletMigrationRollbackStep({
      migration,
      migrationsRepo,
      services: svc,
    })

    expect(svc.pointerService.flipDefaultWallet).toHaveBeenCalledWith({
      accountId: migration.accountId,
      destinationWalletId: "legacy-wallet-id",
    })
    expect(result).toMatchObject({ status: "rolled_back" })
  })

  it("reverses the balance move with the exact forward amount", async () => {
    const migration = {
      ...baseMigration,
      balanceMovePaymentTransactionId: "forward-txn-id",
      sourceBalanceUsdCents: "150000",
      destinationAmountUsdtMicros: "1500000000",
    }
    const migrationsRepo = statefulRepo(migration)
    const svc = services({
      usdtBalanceMicros: "1500000000",
      legacyBalanceUsdCents: "150000", // whole again after the reverse pay
    })

    const result = await executeCashWalletMigrationRollbackStep({
      migration,
      migrationsRepo,
      services: svc,
    })

    expect(svc.invoiceService.createNoAmountInvoice).toHaveBeenCalledWith({
      recipientWalletId: migration.legacyUsdWalletId,
      memo: `cwco-rb:${migration.runId}:${migration.id}:move`,
    })
    expect(svc.paymentService.payInvoice).toHaveBeenCalledWith({
      senderWalletId: migration.destinationUsdtWalletId,
      paymentRequest: invoice.paymentRequest,
      senderAmountUsdtMicros: "1500000000",
    })
    expect(result).toMatchObject({
      status: "rolled_back",
      rollbackPaymentTransactionId: "reverse-txn-id",
    })
  })

  it("reverses the SPENDABLE balance (not the target) when short by only dust (ENG-401)", async () => {
    // The wallet holds target minus the un-reimbursed forward fee + rounding
    // (well within the 1-cent tolerance). Reverse the actual spendable amount,
    // never the target — paying the target would overspend and IBEX 400s.
    const migration = {
      ...baseMigration,
      balanceMovePaymentTransactionId: "forward-txn-id",
      sourceBalanceUsdCents: "150000",
      destinationAmountUsdtMicros: "1500000000",
    }
    const svc = services({
      spendableUsdtMicros: "1499996473", // 3527 micros short = forward fee
      legacyBalanceUsdCents: "150000", // whole again after the reverse pay
    })

    const result = await executeCashWalletMigrationRollbackStep({
      migration,
      migrationsRepo: statefulRepo(migration),
      services: svc,
    })

    expect(svc.paymentService.payInvoice).toHaveBeenCalledWith({
      senderWalletId: migration.destinationUsdtWalletId,
      paymentRequest: invoice.paymentRequest,
      senderAmountUsdtMicros: "1499996473", // the spendable balance, not 1500000000
    })
    expect(result).toMatchObject({ status: "rolled_back" })
  })

  it("fails closed when the reverse amount is below IBEX's minimum payable (ENG-484)", async () => {
    // A 1-cent account with a nearly-drained wallet passes the tolerance gate
    // (shortfall ≤ 1 cent) but the reverse amount is unpayable — fail closed
    // with a clear message instead of a doomed pay and a misleading IBEX 400.
    const migration = {
      ...baseMigration,
      balanceMovePaymentTransactionId: "forward-txn-id",
      sourceBalanceUsdCents: "1",
      destinationAmountUsdtMicros: "10000",
    }
    const svc = services({ spendableUsdtMicros: "2000" }) // below 2500 min payable

    const result = await executeCashWalletMigrationRollbackStep({
      migration,
      migrationsRepo: statefulRepo(migration),
      services: svc,
    })

    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toMatch(/below IBEX's minimum payable/)
    expect(svc.paymentService.payInvoice).not.toHaveBeenCalled()
  })

  it("fails closed when the USDT balance no longer covers the reverse amount", async () => {
    const migration = {
      ...baseMigration,
      balanceMovePaymentTransactionId: "forward-txn-id",
      sourceBalanceUsdCents: "150000",
      destinationAmountUsdtMicros: "1500000000",
    }
    const svc = services({ spendableUsdtMicros: "900000000" }) // user spent funds

    const result = await executeCashWalletMigrationRollbackStep({
      migration,
      migrationsRepo: statefulRepo(migration),
      services: svc,
    })

    expect(result).toBeInstanceOf(CashWalletMigrationFailedError)
    expect(svc.paymentService.payInvoice).not.toHaveBeenCalled()
  })

  it("resumes after a completed reverse payment without paying again", async () => {
    const migration = {
      ...baseMigration,
      balanceMovePaymentTransactionId: "forward-txn-id",
      sourceBalanceUsdCents: "150000",
      destinationAmountUsdtMicros: "1500000000",
      rollbackPointerRestoredAt: NOW,
      rollbackPaymentTransactionId: "reverse-txn-id",
    }
    const svc = services({ legacyBalanceUsdCents: "150000" })

    const result = await executeCashWalletMigrationRollbackStep({
      migration,
      migrationsRepo: statefulRepo(migration),
      services: svc,
    })

    expect(svc.paymentService.payInvoice).not.toHaveBeenCalled()
    expect(result).toMatchObject({ status: "rolled_back" })
  })

  it("tops up a legacy shortfall from treasury and stays in rollback_started", async () => {
    const migration = {
      ...baseMigration,
      balanceMovePaymentTransactionId: "forward-txn-id",
      sourceBalanceUsdCents: "150000",
      destinationAmountUsdtMicros: "1500000000",
      rollbackPointerRestoredAt: NOW,
      rollbackPaymentTransactionId: "reverse-txn-id",
    }
    const migrationsRepo = statefulRepo(migration)
    // 149990 cents received: 10 cents short = 100_000 micros > 1-cent tolerance
    const svc = services({ legacyBalanceUsdCents: "149990" })

    const result = await executeCashWalletMigrationRollbackStep({
      migration,
      migrationsRepo,
      services: svc,
    })

    expect(svc.invoiceService.createNoAmountInvoice).toHaveBeenCalledWith({
      recipientWalletId: migration.legacyUsdWalletId,
      memo: `cwco-rb:${migration.runId}:${migration.id}:shortfall`,
    })
    expect(svc.paymentService.payInvoice).toHaveBeenCalledWith({
      senderWalletId: "treasury-wallet-id",
      paymentRequest: invoice.paymentRequest,
      senderAmountUsdtMicros: "100000",
    })
    expect(result).toMatchObject({
      status: "rollback_started",
      rollbackShortfallPaymentTransactionId: "reverse-txn-id",
    })
  })

  it("tolerates sub-cent dust and finalizes without a treasury payment", async () => {
    const migration = {
      ...baseMigration,
      balanceMovePaymentTransactionId: "forward-txn-id",
      sourceBalanceUsdCents: "150000",
      destinationAmountUsdtMicros: "1500000000",
      rollbackPointerRestoredAt: NOW,
      rollbackPaymentTransactionId: "reverse-txn-id",
    }
    // 0.5 cents short = 5_000 micros <= tolerance
    const svc = services({ legacyBalanceUsdCents: "149999.5" })

    const result = await executeCashWalletMigrationRollbackStep({
      migration,
      migrationsRepo: statefulRepo(migration),
      services: svc,
    })

    expect(svc.paymentService.payInvoice).not.toHaveBeenCalled()
    expect(result).toMatchObject({ status: "rolled_back" })
  })

  it("never double-pays: still short after a treasury top-up fails closed", async () => {
    const migration = {
      ...baseMigration,
      balanceMovePaymentTransactionId: "forward-txn-id",
      sourceBalanceUsdCents: "150000",
      destinationAmountUsdtMicros: "1500000000",
      rollbackPointerRestoredAt: NOW,
      rollbackPaymentTransactionId: "reverse-txn-id",
      rollbackShortfallPaymentTransactionId: "shortfall-txn-id",
    }
    const svc = services({ legacyBalanceUsdCents: "149000" })

    const result = await executeCashWalletMigrationRollbackStep({
      migration,
      migrationsRepo: statefulRepo(migration),
      services: svc,
    })

    expect(result).toBeInstanceOf(CashWalletMigrationFailedError)
    expect(svc.paymentService.payInvoice).not.toHaveBeenCalled()
  })
})

describe("legacyShortfallUsdtMicros", () => {
  it("returns zero when the wallet is whole", () => {
    expect(
      legacyShortfallUsdtMicros({ sourceUsdCents: "150000", currentUsdCents: "150000" }),
    ).toEqual("0")
  })

  it("returns zero when the wallet holds more than the source", () => {
    expect(
      legacyShortfallUsdtMicros({ sourceUsdCents: "150000", currentUsdCents: "150001" }),
    ).toEqual("0")
  })

  it("computes decimal-cent shortfalls in micros", () => {
    expect(
      legacyShortfallUsdtMicros({
        sourceUsdCents: "150000.25",
        currentUsdCents: "149999.5",
      }),
    ).toEqual("7500")
  })
})
