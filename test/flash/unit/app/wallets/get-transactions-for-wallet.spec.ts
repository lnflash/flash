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
  it("maps IBEX USDT currency id to USDT wallet currency", () => {
    const [transaction] = toWalletTransactions([
      {
        id: "trx-id",
        accountId: "wallet-id",
        amount: 19446,
        currencyId: 29,
        transactionTypeId: 1,
        createdAt: "2026-05-13T00:00:00.000Z",
      },
    ] as GResponse200)

    expect(transaction.settlementCurrency).toBe(WalletCurrency.Usdt)
    expect(transaction.settlementAmount).toBe(19446)
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
