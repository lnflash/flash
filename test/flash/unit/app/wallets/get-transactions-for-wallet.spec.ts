import { toWalletTransactions } from "@app/wallets/get-transactions-for-wallet"
import { WalletCurrency } from "@domain/shared"
import { GResponse200 } from "ibex-client"

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
