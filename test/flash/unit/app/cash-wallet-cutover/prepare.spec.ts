import { RepositoryError } from "@domain/errors"

import { preparePrimaryCashWalletCutover } from "@app/cash-wallet-cutover/prepare"

import { WalletCurrency } from "@domain/shared"
import { WalletType } from "@domain/wallets"

const account = (id: AccountId, defaultWalletId: WalletId): Account =>
  ({
    id,
    uuid: `${id}-uuid` as AccountUuid,
    defaultWalletId,
  }) as Account

const wallet = (accountId: AccountId, id: WalletId, currency: WalletCurrency): Wallet =>
  ({
    id,
    accountId,
    type: WalletType.Checking,
    currency,
    onChainAddressIdentifiers: [],
    onChainAddresses: () => [],
    lnurlp: "lnurl" as Lnurl,
  }) as Wallet

async function* unlockedAccounts(accounts: Account[]): AsyncGenerator<Account> {
  for (const account of accounts) yield account
}

describe("prepare primary cash wallet cutover", () => {
  it("discovers accounts, builds preflight, and upserts primary migration records", async () => {
    const accountOne = account("account-1" as AccountId, "account-1-usd" as WalletId)
    const accountTwo = account("account-2" as AccountId, "account-2-usdt" as WalletId)
    const walletsRepo = {
      listByAccountId: jest.fn(async (accountId: AccountId) => [
        wallet(accountId, `${accountId}-usd` as WalletId, WalletCurrency.Usd),
        wallet(accountId, `${accountId}-usdt` as WalletId, WalletCurrency.Usdt),
      ]),
    }
    const migrationsRepo = {
      upsertMigration: jest.fn(async (plan: PrimaryCashWalletMigrationPlan) => ({
        id: `${plan.accountId}-migration`,
        ...plan,
        status: "not_started" as CashWalletMigrationStatus,
        attempts: 0,
        updatedAt: new Date("2026-05-20T00:00:00Z"),
      })),
    }

    const result = await preparePrimaryCashWalletCutover({
      cutoverVersion: 6,
      runId: "run-6",
      accountsRepo: {
        listUnlockedAccounts: () => unlockedAccounts([accountOne, accountTwo]),
      },
      walletsRepo,
      migrationsRepo,
    })

    expect(result).toMatchObject({
      report: {
        totalAccounts: 2,
        migrationCandidates: 1,
        alreadyUsdt: 1,
        blockers: 0,
        canStart: true,
      },
      plannedMigrations: [
        expect.objectContaining({
          accountId: "account-1",
          idempotencyKey: "cash-wallet-cutover:run-6:account-1",
        }),
      ],
      migrations: [expect.objectContaining({ id: "account-1-migration" })],
    })
    expect(migrationsRepo.upsertMigration).toHaveBeenCalledTimes(1)
  })

  it("does not create migration records when preflight has blockers", async () => {
    const blockedAccount = account("account-1" as AccountId, "account-1-usd" as WalletId)
    const migrationsRepo = {
      upsertMigration: jest.fn(),
    }

    const result = await preparePrimaryCashWalletCutover({
      cutoverVersion: 6,
      runId: "run-6",
      accountsRepo: { listUnlockedAccounts: () => unlockedAccounts([blockedAccount]) },
      walletsRepo: {
        listByAccountId: jest.fn(async (accountId: AccountId) => [
          wallet(accountId, `${accountId}-usd` as WalletId, WalletCurrency.Usd),
        ]),
      },
      migrationsRepo,
    })

    expect(result).toMatchObject({
      report: {
        blockers: 1,
        canStart: false,
      },
      plannedMigrations: [],
      migrations: [],
    })
    expect(migrationsRepo.upsertMigration).not.toHaveBeenCalled()
  })

  it("returns repository errors from discovery", async () => {
    const error = new RepositoryError("wallet lookup failed")
    const result = await preparePrimaryCashWalletCutover({
      cutoverVersion: 6,
      runId: "run-6",
      accountsRepo: {
        listUnlockedAccounts: () =>
          unlockedAccounts([account("account-1" as AccountId, "wallet-id" as WalletId)]),
      },
      walletsRepo: { listByAccountId: jest.fn(async () => error) },
      migrationsRepo: { upsertMigration: jest.fn() },
    })

    expect(result).toBe(error)
  })
})
