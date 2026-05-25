jest.mock("@services/mongoose", () => ({
  CashWalletCutoverRepository: jest.fn(),
  WalletsRepository: jest.fn(),
}))

import {
  resolveCashWalletMutationWalletIdForAccount,
  resolveCashWalletPresentationForAccount,
} from "@app/cash-wallet-cutover/presentation-for-account"
import { WalletCurrency } from "@domain/shared"
import { WalletType } from "@domain/wallets"

const account = { id: "account-id", defaultWalletId: "legacy-usd-wallet-id" } as Account

const wallet = ({ id, currency }: { id: string; currency: WalletCurrency }): Wallet =>
  ({
    id,
    accountId: account.id,
    type: WalletType.Checking,
    currency,
  }) as Wallet

const legacyUsdWallet = wallet({
  id: "legacy-usd-wallet-id",
  currency: WalletCurrency.Usd,
})
const usdtWallet = wallet({
  id: "usdt-wallet-id",
  currency: WalletCurrency.Usdt,
})

const config = (state: CashWalletCutoverState): CashWalletCutoverConfig => ({
  state,
  cutoverVersion: 2,
  runId: "run-2",
  updatedAt: new Date("2026-05-19T00:00:00Z"),
})

const migration = (status: CashWalletMigrationStatus): CashWalletMigration => ({
  id: "migration-id",
  accountId: account.id,
  legacyUsdWalletId: legacyUsdWallet.id,
  destinationUsdtWalletId: usdtWallet.id,
  cutoverVersion: 2,
  runId: "run-2",
  status,
  idempotencyKey: "run-2:account-id",
  attempts: 0,
  updatedAt: new Date("2026-05-19T00:00:00Z"),
})

describe("cash wallet presentation for account", () => {
  it("uses existing migration lookup and presents old clients as legacy-compatible after migration", async () => {
    const migrationsRepo = {
      getConfig: jest.fn(async () => config("in_progress")),
      findMigrationByAccountId: jest.fn(async () => migration("complete")),
    }
    const walletsRepo = {
      listByAccountId: jest.fn(async () => [legacyUsdWallet, usdtWallet]),
    }

    const result = await resolveCashWalletPresentationForAccount({
      account,
      client: {
        cashWalletPresentation: "legacy_compat",
        hasUsdtCashWalletSupport: false,
      },
      migrationsRepo,
      walletsRepo,
    })

    expect(result).toEqual({
      wallets: [legacyUsdWallet],
      defaultWalletId: legacyUsdWallet.id,
      legacyUsdWallet,
      activeSettlementWallet: usdtWallet,
    })
    expect(migrationsRepo.findMigrationByAccountId).toHaveBeenCalledWith({
      accountId: account.id,
      cutoverVersion: 2,
      runId: "run-2",
    })
  })

  it("does not require migration lookup after global completion", async () => {
    const migrationsRepo = {
      getConfig: jest.fn(async () => config("complete")),
      findMigrationByAccountId: jest.fn(),
    }
    const walletsRepo = {
      listByAccountId: jest.fn(async () => [legacyUsdWallet, usdtWallet]),
    }

    const result = await resolveCashWalletPresentationForAccount({
      account,
      client: {
        cashWalletPresentation: "usdt",
        hasUsdtCashWalletSupport: true,
      },
      migrationsRepo,
      walletsRepo,
    })

    expect(result).toEqual({
      wallets: [usdtWallet],
      defaultWalletId: usdtWallet.id,
      legacyUsdWallet,
      activeSettlementWallet: usdtWallet,
    })
    expect(migrationsRepo.findMigrationByAccountId).not.toHaveBeenCalled()
  })

  it("routes old-client legacy USD mutation wallet ids to the active settlement wallet", async () => {
    const migrationsRepo = {
      getConfig: jest.fn(async () => config("in_progress")),
      findMigrationByAccountId: jest.fn(async () => migration("complete")),
    }
    const walletsRepo = {
      listByAccountId: jest.fn(async () => [legacyUsdWallet, usdtWallet]),
    }

    const result = await resolveCashWalletMutationWalletIdForAccount({
      account,
      walletId: legacyUsdWallet.id,
      client: {
        cashWalletPresentation: "legacy_compat",
        hasUsdtCashWalletSupport: false,
      },
      migrationsRepo,
      walletsRepo,
    })

    expect(result).toBe(usdtWallet.id)
  })
})
