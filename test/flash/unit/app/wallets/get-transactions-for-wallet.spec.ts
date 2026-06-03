jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: {
    getAccountTransactions: jest.fn(),
  },
}))

import {
  getTransactionsForWallets,
  toWalletTransactions,
} from "@app/wallets/get-transactions-for-wallet"
import { WalletCurrency } from "@domain/shared"
import { WalletType } from "@domain/wallets"
import Ibex from "@services/ibex/client"
import { baseLogger } from "@services/logger"
import { GResponse200 } from "ibex-client"

const accountId = "account-id" as AccountId

const wallet = ({ id, currency }: { id: string; currency: WalletCurrency }): Wallet =>
  ({
    id: id as WalletId,
    accountId,
    currency,
    type: WalletType.Checking,
    onChainAddressIdentifiers: [],
    onChainAddresses: () => [],
    lnurlp: `lnurlp-${id}` as Lnurl,
  }) as Wallet

describe("toWalletTransactions", () => {
  it("maps IBEX USDT currency id to USDT wallet currency with integer micros", () => {
    const transactions = toWalletTransactions([
      {
        id: "trx-id-1",
        accountId: "wallet-id",
        amount: 0.17531,
        currencyId: 29,
        transactionTypeId: 1,
        createdAt: "2026-05-13T00:00:00.000Z",
      },
      {
        id: "trx-id-2",
        accountId: "wallet-id",
        amount: 9.824690376349,
        currencyId: 29,
        transactionTypeId: 1,
        createdAt: "2026-05-13T00:00:00.000Z",
      },
    ] as GResponse200)

    expect(transactions).toHaveLength(2)
    expect(transactions[0].settlementCurrency).toBe(WalletCurrency.Usdt)
    expect(transactions[0].settlementAmount).toBe(175_310)
    expect(transactions[1].settlementAmount).toBe(9_824_690)
    expect(
      transactions.reduce((sum, transaction) => sum + transaction.settlementAmount, 0),
    ).toBe(10_000_000)
  })

  it("maps IBEX USDT send amounts to negative integer micros", () => {
    const [transaction] = toWalletTransactions([
      {
        id: "trx-id",
        accountId: "wallet-id",
        amount: 0.5,
        networkFee: 0.000001,
        currencyId: 29,
        transactionTypeId: 2,
        createdAt: "2026-05-13T00:00:00.000Z",
      },
    ] as GResponse200)

    expect(transaction.settlementCurrency).toBe(WalletCurrency.Usdt)
    expect(transaction.settlementAmount).toBe(-500_000)
    expect(transaction.settlementFee).toBe(1)
  })

  it("defaults omitted IBEX USDT amount and network fee to zero micros", () => {
    const [transaction] = toWalletTransactions([
      {
        id: "trx-id",
        accountId: "wallet-id",
        currencyId: 29,
        transactionTypeId: 1,
        createdAt: "2026-05-13T00:00:00.000Z",
      },
    ] as GResponse200)

    expect(transaction.settlementCurrency).toBe(WalletCurrency.Usdt)
    expect(transaction.settlementAmount).toBe(0)
    expect(transaction.settlementFee).toBe(0)
  })

  it("logs USDT conversion errors with error details", () => {
    const errorSpy = jest.spyOn(baseLogger, "error").mockImplementation()

    const [transaction] = toWalletTransactions([
      {
        id: "trx-id",
        accountId: "wallet-id",
        amount: Number.NaN,
        currencyId: 29,
        transactionTypeId: 1,
        createdAt: "2026-05-13T00:00:00.000Z",
      },
    ] as GResponse200)

    expect(transaction.settlementAmount).toBe(0)
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), amount: expect.any(Number) }),
      "Failed to parse IBEX USDT amount",
    )

    errorSpy.mockRestore()
  })

  it("keeps IBEX USD amounts in integer cents", () => {
    const [transaction] = toWalletTransactions([
      {
        id: "trx-id",
        accountId: "wallet-id",
        amount: 500,
        networkFee: 12,
        currencyId: 3,
        transactionTypeId: 1,
        createdAt: "2026-05-13T00:00:00.000Z",
      },
    ] as GResponse200)

    expect(transaction.settlementCurrency).toBe(WalletCurrency.Usd)
    expect(transaction.settlementAmount).toBe(500)
    expect(transaction.settlementFee).toBe(12)
  })

  it("does not silently classify unknown IBEX currency ids as BTC", () => {
    const [transaction] = toWalletTransactions([
      {
        id: "trx-id",
        accountId: "wallet-id",
        amount: 100,
        currencyId: 999,
        transactionTypeId: 1,
        createdAt: "2026-05-13T00:00:00.000Z",
      },
    ] as GResponse200)

    expect(transaction.settlementCurrency).not.toBe(WalletCurrency.Btc)
    expect(transaction.initiationVia.type).toBe("unknown")
    expect(transaction.settlementVia.type).toBe("unknown")
  })
})

describe("getTransactionsForWallets", () => {
  beforeEach(() => {
    jest.mocked(Ibex.getAccountTransactions).mockReset()
  })

  it("concatenates active wallet history before the legacy archive wallet history", async () => {
    const activeSettlementWallet = wallet({
      id: "33333333-3333-4333-8333-333333333333",
      currency: WalletCurrency.Usdt,
    })
    const legacyUsdWallet = wallet({
      id: "22222222-2222-4222-8222-222222222222",
      currency: WalletCurrency.Usd,
    })

    jest
      .mocked(Ibex.getAccountTransactions)
      .mockImplementation(async ({ account_id }) => {
        if (account_id === activeSettlementWallet.id) {
          return [
            {
              id: "active-newer",
              accountId: activeSettlementWallet.id,
              amount: 100,
              currencyId: 29,
              transactionTypeId: 1,
              createdAt: "2026-06-01T00:00:00.000Z",
            },
          ] as GResponse200
        }

        return [
          {
            id: "legacy-archive-older",
            accountId: legacyUsdWallet.id,
            amount: 200,
            currencyId: 3,
            transactionTypeId: 1,
            createdAt: "2026-05-01T00:00:00.000Z",
          },
        ] as GResponse200
      })

    const result = await getTransactionsForWallets({
      wallets: [activeSettlementWallet, legacyUsdWallet],
      paginationArgs: { first: 20 },
    })

    expect(Ibex.getAccountTransactions).toHaveBeenNthCalledWith(1, {
      account_id: activeSettlementWallet.id,
      limit: 20,
      page: 0,
      sort: "settledAt",
    })
    expect(Ibex.getAccountTransactions).toHaveBeenNthCalledWith(2, {
      account_id: legacyUsdWallet.id,
      limit: 20,
      page: 0,
      sort: "settledAt",
    })
    expect(result.result?.slice.map((transaction) => transaction.id)).toEqual([
      "active-newer",
      "legacy-archive-older",
    ])
  })
})
