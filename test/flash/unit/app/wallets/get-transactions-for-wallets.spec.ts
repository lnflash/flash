import { ExchangeRates } from "@config"
import { toWalletTransactions } from "@app/wallets"
import { CENTS_PER_USD, SAT_PRICE_PRECISION_OFFSET } from "@domain/fiat"

const ibexData = [
  {
    id: "f2fa0473-43b4-4101-8e19-11f1caaeb011",
    createdAt: "2024-01-31T17:27:20.718984Z",
    settledAt: "2024-01-31T17:27:21.422794Z",
    accountId: "e24b85d1-9f61-47da-acb9-fe9d069de2fc",
    amount: 12.34,
    networkFee: 0.01,
    onChainSendFee: 0,
    exchangeRateCurrencySats: 0.013717477287,
    currencyId: 0,
    transactionTypeId: 2,
  },
]

describe("toWalletTransactions", () => {
  it("marks outgoing transactions as negative", () => {
    const result = toWalletTransactions(ibexData as never)

    expect(result[0].settlementAmount).toEqual(-12.34)
  })

  it("uses the requested JMD display currency with precision offset", () => {
    const result = toWalletTransactions(ibexData as never, "JMD" as DisplayCurrency)
    const jmdPerUsdCent = Number(ExchangeRates.jmd.sell.asCents(2)) / CENTS_PER_USD

    expect(result[0].settlementDisplayPrice).toEqual({
      base: BigInt(
        Math.round(
          ibexData[0].exchangeRateCurrencySats *
            jmdPerUsdCent *
            10 ** SAT_PRICE_PRECISION_OFFSET,
        ),
      ),
      offset: BigInt(SAT_PRICE_PRECISION_OFFSET),
      displayCurrency: "JMD",
      walletCurrency: "BTC",
    })

    expect(result[0].settlementDisplayAmount).toBe(
      `${ibexData[0].amount * jmdPerUsdCent}`,
    )
  })
})
