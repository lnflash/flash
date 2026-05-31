import { WalletCurrency } from "@domain/shared"
import { WalletType } from "@domain/wallets"

import { InvalidCashWalletCutoverStateTransitionError } from "@app/cash-wallet-cutover/errors"
import { provisionPrimaryCashWalletUsdtWallets } from "@app/cash-wallet-cutover/provision-usdt-wallets"

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

const config = (state: CashWalletCutoverState): CashWalletCutoverConfig => ({
  state,
  cutoverVersion: 7,
  runId: "run-7",
  updatedAt: new Date("2026-05-20T00:00:00Z"),
})

describe("provision primary cash wallet USDT wallets", () => {
  it("provisions missing USDT wallets without changing existing defaults", async () => {
    const missingUsdtAccount = account(
      "missing-account" as AccountId,
      "missing-account-usd" as WalletId,
    )
    const migrationCandidate = account(
      "candidate-account" as AccountId,
      "candidate-account-usd" as WalletId,
    )
    const alreadyUsdtAccount = account(
      "already-usdt-account" as AccountId,
      "already-usdt-account-usdt" as WalletId,
    )
    const accounts = [missingUsdtAccount, migrationCandidate, alreadyUsdtAccount]
    const walletsByAccountId = new Map<AccountId, Wallet[]>([
      [
        missingUsdtAccount.id,
        [
          wallet(
            missingUsdtAccount.id,
            "missing-account-usd" as WalletId,
            WalletCurrency.Usd,
          ),
        ],
      ],
      [
        migrationCandidate.id,
        [
          wallet(
            migrationCandidate.id,
            "candidate-account-usd" as WalletId,
            WalletCurrency.Usd,
          ),
          wallet(
            migrationCandidate.id,
            "candidate-account-usdt" as WalletId,
            WalletCurrency.Usdt,
          ),
        ],
      ],
      [
        alreadyUsdtAccount.id,
        [
          wallet(
            alreadyUsdtAccount.id,
            "already-usdt-account-usd" as WalletId,
            WalletCurrency.Usd,
          ),
          wallet(
            alreadyUsdtAccount.id,
            "already-usdt-account-usdt" as WalletId,
            WalletCurrency.Usdt,
          ),
        ],
      ],
    ])
    const provisionedWallet = wallet(
      missingUsdtAccount.id,
      "missing-account-usdt" as WalletId,
      WalletCurrency.Usdt,
    )
    const addWalletIfNonexistent = jest.fn(async () => {
      walletsByAccountId.set(missingUsdtAccount.id, [
        ...(walletsByAccountId.get(missingUsdtAccount.id) ?? []),
        provisionedWallet,
      ])
      return provisionedWallet
    })

    const result = await provisionPrimaryCashWalletUsdtWallets({
      cutoverVersion: 7,
      runId: "run-7",
      accountsRepo: { listUnlockedAccounts: () => unlockedAccounts(accounts) },
      walletsRepo: {
        listByAccountId: jest.fn(
          async (accountId: AccountId) => walletsByAccountId.get(accountId) ?? [],
        ),
      },
      migrationsRepo: { getConfig: jest.fn(async () => config("pre")) },
      addWalletIfNonexistent,
      sleep: jest.fn(),
    })

    expect(result).toMatchObject({
      before: {
        totalAccounts: 3,
        migrationCandidates: 1,
        alreadyUsdt: 1,
        blockers: 1,
        canStart: false,
      },
      eligible: 1,
      provisioned: [
        {
          accountId: "missing-account",
          walletId: "missing-account-usdt",
        },
      ],
      failed: [],
      after: {
        totalAccounts: 3,
        migrationCandidates: 2,
        alreadyUsdt: 1,
        blockers: 0,
        canStart: true,
      },
    })
    expect(addWalletIfNonexistent).toHaveBeenCalledTimes(1)
    expect(addWalletIfNonexistent).toHaveBeenCalledWith({
      accountId: missingUsdtAccount.id,
      type: WalletType.Checking,
      currency: WalletCurrency.Usdt,
    })
    expect(missingUsdtAccount.defaultWalletId).toBe("missing-account-usd")
    expect(alreadyUsdtAccount.defaultWalletId).toBe("already-usdt-account-usdt")
  })

  it("does not provision after the cutover has started", async () => {
    const addWalletIfNonexistent = jest.fn()

    const result = await provisionPrimaryCashWalletUsdtWallets({
      cutoverVersion: 7,
      runId: "run-7",
      accountsRepo: { listUnlockedAccounts: () => unlockedAccounts([]) },
      walletsRepo: { listByAccountId: jest.fn() },
      migrationsRepo: { getConfig: jest.fn(async () => config("in_progress")) },
      addWalletIfNonexistent,
    })

    expect(result).toBeInstanceOf(InvalidCashWalletCutoverStateTransitionError)
    expect(addWalletIfNonexistent).not.toHaveBeenCalled()
  })
})
