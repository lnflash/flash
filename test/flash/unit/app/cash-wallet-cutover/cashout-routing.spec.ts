import { resolveCashoutWalletSelection } from "@app/cash-wallet-cutover/cashout-routing"
import {
  CashWalletMigrationFailedError,
  CashWalletMissingUsdtWalletError,
} from "@app/cash-wallet-cutover/errors"
import { WalletCurrency } from "@domain/shared"
import { WalletType } from "@domain/wallets"

const accountId = "user-account-id" as AccountId
const legacyUsdWalletId = "11111111-1111-4111-8111-111111111111" as WalletId
const userUsdtWalletId = "22222222-2222-4222-8222-222222222222" as WalletId

const bankOwnerAccountId = "bank-owner-account-id" as AccountId
const bankOwnerUsdWalletId = "33333333-3333-4333-8333-333333333333" as WalletId
const bankOwnerUsdtWalletId = "44444444-4444-4444-8444-444444444444" as WalletId

const asWallet = (id: WalletId, acctId: AccountId, currency: WalletCurrency): Wallet =>
  ({
    id,
    accountId: acctId,
    currency,
    type: WalletType.Checking,
  }) as Wallet

const userUsdtWallet = asWallet(userUsdtWalletId, accountId, WalletCurrency.Usdt)
const bankOwnerUsdWallet = asWallet(
  bankOwnerUsdWalletId,
  bankOwnerAccountId,
  WalletCurrency.Usd,
)
const bankOwnerUsdtWallet = asWallet(
  bankOwnerUsdtWalletId,
  bankOwnerAccountId,
  WalletCurrency.Usdt,
)

const config = (overrides: Record<string, unknown>) =>
  ({
    cutoverVersion: 1,
    updatedAt: new Date(),
    ...overrides,
  }) as unknown as CashWalletCutoverConfig

// Resolves the bank-owner USDT wallet by account, and the user USDT wallet by account.
const usdtWalletsRepo = () => ({
  findById: jest.fn().mockResolvedValue(bankOwnerUsdWallet),
  listByAccountId: jest
    .fn()
    .mockImplementation(async (id: AccountId) =>
      id === bankOwnerAccountId
        ? [bankOwnerUsdWallet, bankOwnerUsdtWallet]
        : [userUsdtWallet],
    ),
})

describe("resolveCashoutWalletSelection", () => {
  it("routes to the legacy USD wallets pre-cutover, trusting the client walletId", async () => {
    const migrationsRepo = {
      getConfig: jest.fn().mockResolvedValue(config({ state: "pre" })),
      findMigrationByAccountId: jest.fn(),
    }
    const walletsRepo = {
      findById: jest.fn(),
      listByAccountId: jest.fn(),
    }

    const result = await resolveCashoutWalletSelection({
      accountId,
      requestedUserWalletId: legacyUsdWalletId,
      bankOwnerUsdWalletId,
      migrationsRepo,
      walletsRepo,
    })

    expect(result).toEqual({
      route: "legacy_usd",
      userWalletId: legacyUsdWalletId,
      flashWalletId: bankOwnerUsdWalletId,
    })
    expect(migrationsRepo.findMigrationByAccountId).not.toHaveBeenCalled()
    expect(walletsRepo.listByAccountId).not.toHaveBeenCalled()
  })

  it("routes to USDT wallets once the cutover is complete", async () => {
    const migrationsRepo = {
      getConfig: jest.fn().mockResolvedValue(config({ state: "complete" })),
      findMigrationByAccountId: jest.fn(),
    }
    const walletsRepo = usdtWalletsRepo()

    const result = await resolveCashoutWalletSelection({
      accountId,
      requestedUserWalletId: legacyUsdWalletId,
      bankOwnerUsdWalletId,
      migrationsRepo,
      walletsRepo,
    })

    expect(result).toEqual({
      route: "usdt",
      userWalletId: userUsdtWalletId,
      flashWalletId: bankOwnerUsdtWalletId,
    })
  })

  it("stays on legacy USD mid-cutover for an account that has not started migrating", async () => {
    const migrationsRepo = {
      getConfig: jest
        .fn()
        .mockResolvedValue(config({ state: "in_progress", runId: "run-1" })),
      findMigrationByAccountId: jest.fn().mockResolvedValue(null),
    }
    const walletsRepo = { findById: jest.fn(), listByAccountId: jest.fn() }

    const result = await resolveCashoutWalletSelection({
      accountId,
      requestedUserWalletId: legacyUsdWalletId,
      bankOwnerUsdWalletId,
      migrationsRepo,
      walletsRepo,
    })

    expect(result).toEqual({
      route: "legacy_usd",
      userWalletId: legacyUsdWalletId,
      flashWalletId: bankOwnerUsdWalletId,
    })
  })

  it("blocks the cashout when the account migration has failed", async () => {
    const migrationsRepo = {
      getConfig: jest
        .fn()
        .mockResolvedValue(config({ state: "in_progress", runId: "run-1" })),
      findMigrationByAccountId: jest
        .fn()
        .mockResolvedValue({ status: "failed" } as unknown as CashWalletMigration),
    }
    const walletsRepo = { findById: jest.fn(), listByAccountId: jest.fn() }

    const result = await resolveCashoutWalletSelection({
      accountId,
      requestedUserWalletId: legacyUsdWalletId,
      bankOwnerUsdWalletId,
      migrationsRepo,
      walletsRepo,
    })

    expect(result).toBeInstanceOf(CashWalletMigrationFailedError)
  })

  it("errors when the USDT route is selected but the account has no USDT wallet", async () => {
    const migrationsRepo = {
      getConfig: jest.fn().mockResolvedValue(config({ state: "complete" })),
      findMigrationByAccountId: jest.fn(),
    }
    const walletsRepo = {
      findById: jest.fn().mockResolvedValue(bankOwnerUsdWallet),
      listByAccountId: jest
        .fn()
        .mockResolvedValue([asWallet(legacyUsdWalletId, accountId, WalletCurrency.Usd)]),
    }

    const result = await resolveCashoutWalletSelection({
      accountId,
      requestedUserWalletId: legacyUsdWalletId,
      bankOwnerUsdWalletId,
      migrationsRepo,
      walletsRepo,
    })

    expect(result).toBeInstanceOf(CashWalletMissingUsdtWalletError)
  })
})
