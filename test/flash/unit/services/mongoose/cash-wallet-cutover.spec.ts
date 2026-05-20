import { CashWalletCutoverRepository } from "@services/mongoose/cash-wallet-cutover"
import { CashWalletCutoverConfig, CashWalletMigration } from "@services/mongoose/schema"

jest.mock("@services/mongoose/schema", () => ({
  CashWalletCutoverConfig: {
    findById: jest.fn(),
    findOneAndUpdate: jest.fn(),
  },
  CashWalletMigration: {
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    find: jest.fn(),
    countDocuments: jest.fn(),
  },
}))

describe("CashWalletCutoverRepository", () => {
  const repo = CashWalletCutoverRepository()
  const updatedAt = new Date("2026-05-19T00:00:00Z")

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("returns default pre state when no config exists", async () => {
    jest.mocked(CashWalletCutoverConfig.findById).mockResolvedValue(null as never)

    const result = await repo.getConfig()

    expect(result).toEqual({
      state: "pre",
      cutoverVersion: 1,
      updatedAt: new Date(0),
    })
  })

  it("upserts singleton config", async () => {
    jest.mocked(CashWalletCutoverConfig.findOneAndUpdate).mockResolvedValue({
      _id: "cash_wallet_cutover",
      state: "in_progress",
      cutoverVersion: 2,
      runId: "run-2",
      updatedBy: "operator",
      updatedAt,
    } as never)

    const result = await repo.updateConfig(
      { state: "in_progress", cutoverVersion: 2, runId: "run-2" },
      "operator",
    )

    expect(CashWalletCutoverConfig.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: "cash_wallet_cutover" },
      expect.objectContaining({
        $set: expect.objectContaining({
          state: "in_progress",
          cutoverVersion: 2,
          runId: "run-2",
          updatedBy: "operator",
        }),
      }),
      { upsert: true, new: true },
    )
    expect(result).toMatchObject({
      state: "in_progress",
      cutoverVersion: 2,
      runId: "run-2",
    })
  })

  it("creates one migration record per account id and run", async () => {
    jest.mocked(CashWalletMigration.findOneAndUpdate).mockResolvedValue({
      _id: "migration-id",
      accountId: "account-id",
      legacyUsdWalletId: "usd-wallet-id",
      destinationUsdtWalletId: "usdt-wallet-id",
      cutoverVersion: 2,
      runId: "run-2",
      status: "not_started",
      idempotencyKey: "run-2:account-id",
      attempts: 0,
      updatedAt,
    } as never)

    const result = await repo.upsertMigration({
      accountId: "account-id" as AccountId,
      legacyUsdWalletId: "usd-wallet-id" as WalletId,
      destinationUsdtWalletId: "usdt-wallet-id" as WalletId,
      cutoverVersion: 2,
      runId: "run-2",
      idempotencyKey: "run-2:account-id",
    })

    expect(CashWalletMigration.findOneAndUpdate).toHaveBeenCalledWith(
      { accountId: "account-id", runId: "run-2" },
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({
          accountId: "account-id",
          runId: "run-2",
          status: "not_started",
        }),
      }),
      { upsert: true, new: true },
    )
    expect(result).toMatchObject({ id: "migration-id", accountId: "account-id" })
  })

  it("transitions migration status atomically", async () => {
    jest.mocked(CashWalletMigration.findOneAndUpdate).mockResolvedValue({
      _id: "migration-id",
      accountId: "account-id",
      legacyUsdWalletId: "usd-wallet-id",
      destinationUsdtWalletId: "usdt-wallet-id",
      cutoverVersion: 2,
      runId: "run-2",
      status: "started",
      idempotencyKey: "run-2:account-id",
      attempts: 0,
      updatedAt,
    } as never)

    const result = await repo.transitionMigration({
      id: "migration-id",
      from: "not_started",
      to: "started",
      cutoverVersion: 2,
      runId: "run-2",
      patch: { startedAt: updatedAt },
    })

    expect(CashWalletMigration.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: "migration-id", status: "not_started", cutoverVersion: 2, runId: "run-2" },
      expect.objectContaining({ $set: expect.objectContaining({ status: "started" }) }),
      { new: true },
    )
    expect(result).toMatchObject({ status: "started" })
  })

  it("acquires and rejects active locks atomically", async () => {
    const staleBefore = new Date("2026-05-19T00:00:00Z")
    jest.mocked(CashWalletMigration.findOneAndUpdate).mockResolvedValue(null as never)

    const result = await repo.acquireMigrationLock({
      id: "migration-id",
      workerId: "worker-1",
      staleBefore,
      cutoverVersion: 2,
      runId: "run-2",
    })

    expect(CashWalletMigration.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: "migration-id",
        cutoverVersion: 2,
        runId: "run-2",
        $or: [{ lockedAt: null }, { lockedAt: { $lt: staleBefore } }],
      },
      expect.objectContaining({
        $set: expect.objectContaining({ lockedBy: "worker-1" }),
      }),
      { new: true },
    )
    expect(result).toBeInstanceOf(Error)
  })

  it("finds resumable non-terminal migrations for the current run", async () => {
    const limit = jest.fn().mockResolvedValue([])
    const sort = jest.fn(() => ({ limit }))
    jest.mocked(CashWalletMigration.find).mockReturnValue({ sort } as never)

    const result = await repo.listRunnableMigrations({
      cutoverVersion: 2,
      runId: "run-2",
      limit: 10,
    })

    expect(CashWalletMigration.find).toHaveBeenCalledWith(
      expect.objectContaining({
        cutoverVersion: 2,
        runId: "run-2",
        status: {
          $nin: expect.arrayContaining([
            "complete",
            "failed",
            "requires_operator_review",
          ]),
        },
      }),
    )
    expect(sort).toHaveBeenCalledWith({ updatedAt: 1 })
    expect(limit).toHaveBeenCalledWith(10)
    expect(result).toEqual([])
  })
})
