jest.mock("@app/accounts", () => ({
  addWalletIfNonexistent: jest.fn(),
  updateDefaultWalletId: jest.fn(),
}))
jest.mock("@app/wallets", () => ({
  addInvoiceForRecipientForUsdWallet: jest.fn(),
  addInvoiceNoAmountForRecipient: jest.fn(),
  getBalanceForWallet: jest.fn(),
}))
jest.mock("@services/mongoose", () => ({
  AccountsRepository: jest.fn(() => ({ findById: jest.fn() })),
  CashWalletCutoverRepository: jest.fn(),
}))
jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: {
    payInvoice: jest.fn(),
    getTransactionDetails: jest.fn(),
  },
}))

import { runPrimaryCashWalletCutoverBatch } from "@app/cash-wallet-cutover/orchestrator"

const migration = (status: CashWalletMigrationStatus): CashWalletMigration => ({
  id: "migration-id",
  accountId: "account-id" as AccountId,
  legacyUsdWalletId: "legacy-usd-wallet-id" as WalletId,
  destinationUsdtWalletId: "usdt-wallet-id" as WalletId,
  cutoverVersion: 7,
  runId: "run-7",
  status,
  idempotencyKey: "cash-wallet-cutover:run-7:account-id",
  attempts: 0,
  updatedAt: new Date("2026-05-20T00:00:00Z"),
})

describe("primary cash wallet cutover orchestrator", () => {
  it("runs a locked batch with default step handlers", async () => {
    const started = migration("not_started")
    const locked = migration("not_started")
    const migrationsRepo = {
      transitionMigration: jest.fn(async () => migration("started")),
      listRunnableMigrations: jest.fn(async () => [started]),
      acquireMigrationLock: jest.fn(async () => locked),
      markMigrationFailed: jest.fn(),
      releaseMigrationLock: jest.fn(async () => locked),
    }
    const runtimeServices = {
      now: jest.fn(() => new Date("2026-05-20T16:00:00Z")),
      provisioningService: { ensureDestinationWallet: jest.fn() },
      balanceReader: {
        readSourceBalanceUsdCents: jest.fn(),
        readDestinationBalanceUsdtMicros: jest.fn(),
      },
      invoiceService: { createInvoice: jest.fn(), createNoAmountInvoice: jest.fn() },
      paymentService: { payInvoice: jest.fn() },
      balanceVerifier: { verifyBalanceMove: jest.fn() },
      feeService: { readFeeAmountUsdtMicros: jest.fn() },
      treasuryService: { getTreasuryWalletId: jest.fn() },
      pointerService: { flipDefaultWallet: jest.fn() },
      legacyWalletVerifier: { verifyLegacyWalletZero: jest.fn() },
    }

    const result = await runPrimaryCashWalletCutoverBatch({
      cutoverVersion: 7,
      runId: "run-7",
      workerId: "worker-1",
      limit: 5,
      lockStaleBefore: new Date("2026-05-20T15:00:00Z"),
      migrationsRepo,
      runtimeServices,
    })

    expect(result).toEqual({ attempted: 1, advanced: 1, failed: 0, skipped: 0 })
    expect(migrationsRepo.transitionMigration).toHaveBeenCalledWith({
      id: "migration-id",
      from: "not_started",
      to: "started",
      cutoverVersion: 7,
      runId: "run-7",
      patch: { startedAt: new Date("2026-05-20T16:00:00Z") },
    })
  })
})
