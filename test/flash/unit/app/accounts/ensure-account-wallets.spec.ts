import { CouldNotFindError, PersistError } from "@domain/errors"
import { WalletCurrency } from "@domain/shared"
import { WalletType } from "@domain/wallets"

import { AccountsRepository, WalletsRepository } from "@services/mongoose"

import {
  createMissingCashWallets,
  ensureCashWallets,
} from "@app/accounts/ensure-account-wallets"

jest.mock("@services/mongoose", () => ({
  AccountsRepository: jest.fn(),
  WalletsRepository: jest.fn(),
}))

jest.mock("@services/tracing", () => ({
  recordExceptionInCurrentSpan: jest.fn(),
}))

const mockedPersistNew = jest.fn()
const mockedListByAccountId = jest.fn()
const mockedUpdate = jest.fn()

const cashWallet = (currency: WalletCurrency, id: string): Wallet =>
  ({
    id,
    accountId: "account-id",
    type: WalletType.Checking,
    currency,
  }) as unknown as Wallet

const stubRepositories = () => {
  mockedPersistNew.mockImplementation(
    async ({ currency }: { currency: WalletCurrency }) =>
      cashWallet(currency, `${currency}-wallet-id`),
  )
  mockedListByAccountId.mockResolvedValue([])
  mockedUpdate.mockImplementation(async (account: Account) => account)

  jest.mocked(WalletsRepository).mockReturnValue({
    persistNew: mockedPersistNew,
    listByAccountId: mockedListByAccountId,
  } as never)
  jest.mocked(AccountsRepository).mockReturnValue({ update: mockedUpdate } as never)
}

beforeEach(() => {
  jest.clearAllMocks()
  stubRepositories()
})

describe("createMissingCashWallets", () => {
  it("creates every required cash wallet for an account that has none", async () => {
    const result = await createMissingCashWallets({
      accountId: "account-id" as AccountId,
      currencies: [WalletCurrency.Usd],
      existingWallets: [],
    })

    expect(result).not.toBeInstanceOf(Error)
    expect(mockedPersistNew).toHaveBeenCalledTimes(2)
    expect((result as Record<WalletCurrency, Wallet>)[WalletCurrency.Usdt].id).toBe(
      `${WalletCurrency.Usdt}-wallet-id`,
    )
  })

  // The point of the helper: a retry after a partial failure must not write a
  // second wallet for a currency that already has one.
  it("reuses the wallets an earlier attempt already created", async () => {
    const existing = cashWallet(WalletCurrency.Usd, "usd-from-first-attempt")

    const result = await createMissingCashWallets({
      accountId: "account-id" as AccountId,
      currencies: [WalletCurrency.Usd],
      existingWallets: [existing],
    })

    expect(mockedPersistNew).toHaveBeenCalledTimes(1)
    expect(mockedPersistNew).toHaveBeenCalledWith({
      accountId: "account-id",
      type: WalletType.Checking,
      currency: WalletCurrency.Usdt,
    })
    expect((result as Record<WalletCurrency, Wallet>)[WalletCurrency.Usd]).toBe(existing)
  })

  it("fails when a required cash wallet cannot be created", async () => {
    mockedPersistNew.mockImplementation(async ({ currency }: { currency: WalletCurrency }) =>
      currency === WalletCurrency.Usdt
        ? new PersistError("IBEX unavailable")
        : cashWallet(currency, `${currency}-wallet-id`),
    )

    const result = await createMissingCashWallets({
      accountId: "account-id" as AccountId,
      currencies: [],
      existingWallets: [],
    })

    expect(result).toBeInstanceOf(PersistError)
  })

  it("keeps going when only an optional wallet fails", async () => {
    mockedPersistNew.mockImplementation(async ({ currency }: { currency: WalletCurrency }) =>
      currency === WalletCurrency.Btc
        ? new PersistError("no btc wallet")
        : cashWallet(currency, `${currency}-wallet-id`),
    )

    const result = await createMissingCashWallets({
      accountId: "account-id" as AccountId,
      currencies: [WalletCurrency.Btc],
      existingWallets: [],
    })

    expect(result).not.toBeInstanceOf(Error)
    expect(Object.keys(result as Record<string, Wallet>)).toHaveLength(2)
  })
})

describe("ensureCashWallets", () => {
  it("fills in the default wallet id of an account left without wallets", async () => {
    const result = await ensureCashWallets(
      { id: "account-id" } as unknown as Account,
      [],
    )

    expect(result).not.toBeInstanceOf(Error)
    expect((result as Account).defaultWalletId).toBe(`${WalletCurrency.Usdt}-wallet-id`)
    expect(mockedUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ defaultWalletId: `${WalletCurrency.Usdt}-wallet-id` }),
    )
  })

  // Healing must be idempotent: the read path runs it on the next request, and
  // an account that is already complete should not be rewritten.
  it("does not rewrite an account that already points at the default wallet", async () => {
    mockedListByAccountId.mockResolvedValue([
      cashWallet(WalletCurrency.Usdt, "usdt-wallet-id"),
      cashWallet(WalletCurrency.Usd, "usd-wallet-id"),
    ])

    const account = {
      id: "account-id",
      defaultWalletId: "usdt-wallet-id" as WalletId,
    } as unknown as Account

    const result = await ensureCashWallets(account, [])

    expect(result).toBe(account)
    expect(mockedUpdate).not.toHaveBeenCalled()
    expect(mockedPersistNew).not.toHaveBeenCalled()
  })

  it("surfaces a repository failure while reading existing wallets", async () => {
    mockedListByAccountId.mockResolvedValue(new PersistError("mongo down"))

    const result = await ensureCashWallets(
      { id: "account-id" } as unknown as Account,
      [],
    )

    expect(result).toBeInstanceOf(PersistError)
    expect(mockedPersistNew).not.toHaveBeenCalled()
  })

  it("reports when no cash wallet could be enabled at all", async () => {
    mockedPersistNew.mockResolvedValue(undefined)

    const result = await ensureCashWallets(
      { id: "account-id" } as unknown as Account,
      [],
    )

    expect(result).toBeInstanceOf(CouldNotFindError)
    expect(mockedUpdate).not.toHaveBeenCalled()
  })
})
