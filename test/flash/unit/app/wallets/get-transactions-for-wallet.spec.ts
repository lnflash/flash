import { ExchangeRates } from "@config"
import { toWalletTransactions } from "@app/wallets/get-transactions-for-wallet"

const jmdCentsPerUsdDollar = () => Number(ExchangeRates.jmd.sell.asCents())

const usdCentsForJmdMajor = (jmdMajor: number) =>
  (jmdMajor * 100 * 100) / jmdCentsPerUsdDollar()

const ibexUsdTransaction = (amount: number) =>
  [
    {
      accountId: "wallet-id",
      amount,
      createdAt: "2026-03-20T00:00:00.000Z",
      currencyId: 3,
      exchangeRateCurrencySats: 0.001,
      id: `tx-${amount}`,
      networkFee: 0,
      transactionTypeId: 1,
    },
  ] as Parameters<typeof toWalletTransactions>[0]

describe("toWalletTransactions", () => {
  it.each([
    [15.15, "15.15"],
    [100, "100.00"],
    [12_500.01, "12500.01"],
  ])("returns JMD settlement display amount for JMD$%s", (jmdMajor, expected) => {
    const [transaction] = toWalletTransactions(
      ibexUsdTransaction(usdCentsForJmdMajor(jmdMajor)),
      "JMD" as DisplayCurrency,
    )

    expect(transaction.settlementDisplayAmount).toBe(expected)
    expect(transaction.settlementDisplayPrice.displayCurrency).toBe("JMD")
  })

  it("uses a precise non-zero settlement display price for sub-cent BTC rates", () => {
    const [transaction] = toWalletTransactions(
      [
        {
          accountId: "wallet-id",
          amount: 1,
          createdAt: "2026-03-20T00:00:00.000Z",
          currencyId: 1,
          exchangeRateCurrencySats: 0.001,
          id: "btc-tx",
          networkFee: 0,
          transactionTypeId: 1,
        },
      ] as Parameters<typeof toWalletTransactions>[0],
      "JMD" as DisplayCurrency,
    )

    expect(transaction.settlementDisplayPrice.base).toBeGreaterThan(0n)
    expect(transaction.settlementDisplayPrice.displayCurrency).toBe("JMD")
  })
})
