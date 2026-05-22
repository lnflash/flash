import { toWalletTransactions } from "@app/wallets/get-transactions-for-wallet"
import { WalletCurrency } from "@domain/shared"

import { GResponse200 } from "ibex-client"

const jmdDisplayCurrency = WalletCurrency.Jmd as DisplayCurrency
const usdDisplayCurrency = WalletCurrency.Usd as DisplayCurrency
const jmdPerUsd = 160

const ibexTransaction = ({
  amount,
  networkFee = 0,
  transactionTypeId = 1,
}: {
  amount: number
  networkFee?: number
  transactionTypeId?: number
}) => ({
  id: "tx-id",
  createdAt: "2026-05-21T00:00:00.000Z",
  accountId: "wallet-id",
  amount,
  networkFee,
  exchangeRateCurrencySats: 0.000001,
  currencyId: 3,
  transactionTypeId,
})

describe("toWalletTransactions", () => {
  it.each`
    jmdMajor
    ${15.15}
    ${100.0}
    ${12500.01}
  `(
    "converts historical USD wallet amount to JMD $jmdMajor display amount",
    ({ jmdMajor }: { jmdMajor: number }) => {
      const [transaction] = toWalletTransactions(
        [ibexTransaction({ amount: jmdMajor / jmdPerUsd })] as GResponse200,
        jmdDisplayCurrency,
      )

      expect(transaction.settlementDisplayAmount).toBe(jmdMajor.toFixed(2))
      expect(transaction.settlementDisplayPrice.displayCurrency).toBe(jmdDisplayCurrency)
      expect(transaction.settlementDisplayPrice.walletCurrency).toBe(WalletCurrency.Usd)
      expect(transaction.settlementDisplayPrice.offset).toBe(6n)
    },
  )

  it("keeps USD display amounts and returns settlement amounts in cents", () => {
    const [transaction] = toWalletTransactions(
      [ibexTransaction({ amount: 8.01, networkFee: 0.03 })] as GResponse200,
      usdDisplayCurrency,
    )

    expect(transaction.settlementAmount).toBe(801)
    expect(transaction.settlementFee).toBe(3)
    expect(transaction.settlementDisplayAmount).toBe("8.01")
    expect(transaction.settlementDisplayFee).toBe("0.03")
    expect(transaction.settlementDisplayPrice.displayCurrency).toBe(usdDisplayCurrency)
  })

  it("preserves send direction sign for JMD display amounts", () => {
    const [transaction] = toWalletTransactions(
      [
        ibexTransaction({ amount: 15.15 / jmdPerUsd, transactionTypeId: 2 }),
      ] as GResponse200,
      jmdDisplayCurrency,
    )

    expect(transaction.settlementAmount).toBe(-9)
    expect(transaction.settlementDisplayAmount).toBe("-15.15")
  })
})
