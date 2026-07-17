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
  it("maps IBEX USDT currency id to USDT wallet currency with integer cents", () => {
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
    expect(transactions[0].settlementAmount).toBe(18)
    expect(transactions[1].settlementAmount).toBe(982)
    expect(
      transactions.reduce((sum, transaction) => sum + transaction.settlementAmount, 0),
    ).toBe(1_000)
  })

  it("maps IBEX USDT send amounts to negative integer cents", () => {
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
    expect(transaction.settlementAmount).toBe(-50)
    expect(transaction.settlementDisplayAmount).toBe("-0.5")
    expect(transaction.settlementFee).toBe(0)
  })

  it("maps IBEX crypto send transaction type to outgoing on-chain USDT", () => {
    const [transaction] = toWalletTransactions([
      {
        id: "crypto-send-trx-id",
        accountId: "wallet-id",
        amount: 2.5,
        networkFee: 0.179554,
        currencyId: 29,
        transactionTypeId: 10,
        createdAt: "2026-06-17T05:42:53.512218Z",
      },
    ] as GResponse200)

    expect(transaction.settlementCurrency).toBe(WalletCurrency.Usdt)
    expect(transaction.settlementAmount).toBe(-250)
    expect(transaction.settlementDisplayAmount).toBe("-2.5")
    expect(transaction.settlementFee).toBe(18)
    expect(transaction.settlementDisplayFee).toBe("0.179554")
    expect(transaction.initiationVia.type).toBe("onchain")
    expect(transaction.settlementVia.type).toBe("onchain")
  })

  it("defaults omitted IBEX USDT amount and network fee to zero cents", () => {
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

  it("excludes transactions with unknown IBEX currency ids from the list", () => {
    const errorSpy = jest.spyOn(baseLogger, "error").mockImplementation()

    const transactions = toWalletTransactions([
      {
        id: "trx-id",
        accountId: "wallet-id",
        amount: 100,
        currencyId: 999,
        transactionTypeId: 1,
        createdAt: "2026-05-13T00:00:00.000Z",
      },
    ] as GResponse200)

    expect(transactions).toHaveLength(0)
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to parse Ibex transaction currency"),
    )

    errorSpy.mockRestore()
  })

  it("maps unknown IBEX transaction type ids to intraledger with valid amounts", () => {
    const errorSpy = jest.spyOn(baseLogger, "error").mockImplementation()

    const [transaction] = toWalletTransactions([
      {
        id: "trx-id",
        accountId: "wallet-id",
        amount: 250,
        networkFee: 1,
        currencyId: 3,
        transactionTypeId: 99,
        createdAt: "2026-05-13T00:00:00.000Z",
      },
    ] as GResponse200)

    expect(transaction.settlementCurrency).toBe(WalletCurrency.Usd)
    expect(transaction.settlementAmount).toBe(250)
    expect(transaction.settlementFee).toBe(1)
    expect(transaction.initiationVia.type).toBe("intraledger")
    expect(transaction.settlementVia.type).toBe("intraledger")
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to parse Ibex transaction type"),
    )

    errorSpy.mockRestore()
  })

  it("never emits via types outside the GraphQL union members", () => {
    const resolvable = ["intraledger", "lightning", "onchain"]

    const transactions = toWalletTransactions(
      [3, 29].flatMap((currencyId) =>
        [1, 2, 3, 4, 10, 99, undefined].map((transactionTypeId, i) => ({
          id: `trx-${currencyId}-${i}`,
          accountId: "wallet-id",
          amount: 10,
          currencyId,
          transactionTypeId,
          createdAt: "2026-05-13T00:00:00.000Z",
        })),
      ) as GResponse200,
    )

    expect(transactions).toHaveLength(14)
    for (const transaction of transactions) {
      expect(resolvable).toContain(transaction.initiationVia.type)
      expect(resolvable).toContain(transaction.settlementVia.type)
    }
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
