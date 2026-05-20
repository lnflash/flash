import { RepositoryError } from "@domain/errors"

import { upsertPrimaryCashWalletMigrationRecords } from "@app/cash-wallet-cutover/migration-records"

const plan = (accountId: AccountId): PrimaryCashWalletMigrationPlan => ({
  accountId,
  accountUuid: `${accountId}-uuid` as AccountUuid,
  legacyUsdWalletId: `${accountId}-usd` as WalletId,
  destinationUsdtWalletId: `${accountId}-usdt` as WalletId,
  previousDefaultWalletId: `${accountId}-default` as WalletId,
  cutoverVersion: 5,
  runId: "run-5",
  idempotencyKey: `cash-wallet-cutover:run-5:${accountId}`,
})

describe("cash wallet migration record upsert", () => {
  it("upserts one not-started migration record for each primary plan", async () => {
    const migrationsRepo = {
      upsertMigration: jest.fn(async (args) => ({
        id: `${args.accountId}-migration`,
        ...args,
        status: "not_started" as CashWalletMigrationStatus,
        attempts: 0,
        updatedAt: new Date("2026-05-20T00:00:00Z"),
      })),
    }

    const result = await upsertPrimaryCashWalletMigrationRecords({
      migrationsRepo,
      plans: [plan("account-1" as AccountId), plan("account-2" as AccountId)],
    })

    expect(result).toEqual([
      expect.objectContaining({ id: "account-1-migration", accountId: "account-1" }),
      expect.objectContaining({ id: "account-2-migration", accountId: "account-2" }),
    ])
    expect(migrationsRepo.upsertMigration).toHaveBeenCalledTimes(2)
    expect(migrationsRepo.upsertMigration).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        accountId: "account-1",
        accountUuid: "account-1-uuid",
        legacyUsdWalletId: "account-1-usd",
        destinationUsdtWalletId: "account-1-usdt",
        previousDefaultWalletId: "account-1-default",
        cutoverVersion: 5,
        runId: "run-5",
        idempotencyKey: "cash-wallet-cutover:run-5:account-1",
      }),
    )
  })

  it("returns repository errors and stops creating more records", async () => {
    const error = new RepositoryError("could not upsert migration")
    const migrationsRepo = {
      upsertMigration: jest
        .fn()
        .mockResolvedValueOnce(error)
        .mockResolvedValueOnce({} as CashWalletMigration),
    }

    const result = await upsertPrimaryCashWalletMigrationRecords({
      migrationsRepo,
      plans: [plan("account-1" as AccountId), plan("account-2" as AccountId)],
    })

    expect(result).toBe(error)
    expect(migrationsRepo.upsertMigration).toHaveBeenCalledTimes(1)
  })
})
