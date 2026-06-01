import { RepositoryError } from "@domain/errors"

import { discoverCashWalletCutoverAccounts } from "@app/cash-wallet-cutover/discovery"

import { WalletCurrency } from "@domain/shared"
import { WalletType } from "@domain/wallets"

const account = (id: AccountId, defaultWalletId: WalletId): Account =>
  ({
    id,
    uuid: `${id}-uuid` as AccountUuid,
    defaultWalletId,
  }) as Account

const wallet = ({
  id,
  accountId,
  currency,
}: {
  id: WalletId
  accountId: AccountId
  currency: WalletCurrency
}): Wallet =>
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

describe("cash wallet cutover account discovery collector", () => {
  it("classifies every unlocked account with its wallets", async () => {
    const accountOne = account("account-1" as AccountId, "account-1-usd" as WalletId)
    const accountTwo = account("account-2" as AccountId, "account-2-usdt" as WalletId)
    const walletsRepo = {
      listByAccountId: jest.fn(async (accountId: AccountId) => [
        wallet({
          id: `${accountId}-usd` as WalletId,
          accountId,
          currency: WalletCurrency.Usd,
        }),
        wallet({
          id: `${accountId}-usdt` as WalletId,
          accountId,
          currency: WalletCurrency.Usdt,
        }),
      ]),
    }

    const result = await discoverCashWalletCutoverAccounts({
      accountsRepo: {
        listUnlockedAccounts: () => unlockedAccounts([accountOne, accountTwo]),
      },
      walletsRepo,
    })

    expect(result).toEqual([
      expect.objectContaining({ accountId: "account-1", status: "legacy_default" }),
      expect.objectContaining({ accountId: "account-2", status: "already_usdt" }),
    ])
    expect(walletsRepo.listByAccountId).toHaveBeenCalledWith("account-1")
    expect(walletsRepo.listByAccountId).toHaveBeenCalledWith("account-2")
  })

  it("returns repository errors without continuing discovery", async () => {
    const accountOne = account("account-1" as AccountId, "account-1-usd" as WalletId)
    const error = new RepositoryError("wallet lookup failed")
    const walletsRepo = {
      listByAccountId: jest.fn(async () => error),
    }

    const result = await discoverCashWalletCutoverAccounts({
      accountsRepo: { listUnlockedAccounts: () => unlockedAccounts([accountOne]) },
      walletsRepo,
    })

    expect(result).toBe(error)
  })
})
