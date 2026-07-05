import { retryFailedCashWalletMigrations } from "@app/cash-wallet-cutover/retry-failed"

const baseMigration = {
  id: "migration-id",
  accountId: "account-id" as AccountId,
  legacyUsdWalletId: "legacy-wallet-id" as WalletId,
  destinationUsdtWalletId: "destination-wallet-id" as WalletId,
  cutoverVersion: 1,
  runId: "run-id",
  status: "failed",
  idempotencyKey: "run-id:account-id",
  attempts: 3,
  lastError: "FetchError: Too Many Requests",
  updatedAt: new Date("2026-07-05T00:00:00.000Z"),
} as CashWalletMigration

const repo = (migrations: CashWalletMigration[]) => ({
  findMigrationByAccountId: jest.fn(async ({ accountId }) => {
    return migrations.find((m) => m.accountId === accountId) ?? null
  }),
  listMigrationsByStatuses: jest.fn(async () => migrations),
  transitionMigration: jest.fn(async ({ to, patch }) => ({
    ...migrations[0],
    ...patch,
    status: to,
  })),
})

describe("retryFailedCashWalletMigrations", () => {
  it("resets a pre-money failure to not_started, clearing stale progress", async () => {
    const migrationsRepo = repo([
      { ...baseMigration, sourceBalanceUsdCents: "100" } as CashWalletMigration,
    ])

    const report = await retryFailedCashWalletMigrations({
      cutoverVersion: 1,
      runId: "run-id",
      migrationsRepo: migrationsRepo as never,
    })

    expect(report).toMatchObject({
      eligible: 1,
      retried: 1,
      skippedMoneyMoved: 0,
      resumedAt: { not_started: 1 },
    })
    expect(migrationsRepo.transitionMigration).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "failed",
        to: "not_started",
        patch: { attempts: 0 },
        clear: expect.arrayContaining(["lastError", "sourceBalanceUsdCents"]),
      }),
    )
  })

  it("resumes a post-pointer failure at pointer_flipped, preserving the pointer", async () => {
    const migrationsRepo = repo([
      {
        ...baseMigration,
        previousDefaultWalletId: "legacy-wallet-id" as WalletId,
      } as CashWalletMigration,
    ])

    const report = await retryFailedCashWalletMigrations({
      cutoverVersion: 1,
      runId: "run-id",
      migrationsRepo: migrationsRepo as never,
    })

    expect(report).toMatchObject({ retried: 1, resumedAt: { pointer_flipped: 1 } })
    const call = migrationsRepo.transitionMigration.mock.calls[0][0]
    expect(call.to).toBe("pointer_flipped")
    expect(call.clear).toEqual(["lastError"])
    expect(call.clear).not.toContain("previousDefaultWalletId")
  })

  it("never retries a failure with a recorded payment transaction", async () => {
    const migrationsRepo = repo([
      {
        ...baseMigration,
        balanceMovePaymentTransactionId: "txn-id",
      } as CashWalletMigration,
    ])

    const report = await retryFailedCashWalletMigrations({
      cutoverVersion: 1,
      runId: "run-id",
      migrationsRepo: migrationsRepo as never,
    })

    expect(report).toMatchObject({ eligible: 0, retried: 0, skippedMoneyMoved: 1 })
    expect(migrationsRepo.transitionMigration).not.toHaveBeenCalled()
  })

  it("dry-run reports without writing", async () => {
    const migrationsRepo = repo([baseMigration])

    const report = await retryFailedCashWalletMigrations({
      cutoverVersion: 1,
      runId: "run-id",
      dryRun: true,
      migrationsRepo: migrationsRepo as never,
    })

    expect(report).toMatchObject({ dryRun: true, eligible: 1, retried: 0 })
    expect(migrationsRepo.transitionMigration).not.toHaveBeenCalled()
  })

  it("rejects single-account retry when the migration is not failed", async () => {
    const migrationsRepo = repo([
      { ...baseMigration, status: "complete" } as CashWalletMigration,
    ])

    const result = await retryFailedCashWalletMigrations({
      cutoverVersion: 1,
      runId: "run-id",
      accountId: "account-id" as AccountId,
      migrationsRepo: migrationsRepo as never,
    })

    expect(result).toBeInstanceOf(Error)
  })
})
