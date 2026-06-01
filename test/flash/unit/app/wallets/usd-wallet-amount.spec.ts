import { usdWalletAmountFromInput } from "@app/wallets/usd-wallet-amount"
import { USDAmount, USDTAmount, WalletCurrency } from "@domain/shared"

describe("usdWalletAmountFromInput", () => {
  it("treats USD wallet input as cents", () => {
    const amount = usdWalletAmountFromInput("19446", WalletCurrency.Usd)

    expect(amount).toBeInstanceOf(USDAmount)
    expect((amount as USDAmount).asCents()).toBe("19446")
    expect((amount as USDAmount).toIbex()).toBe(194.46)
  })

  it("treats USDT wallet input as USD cents", () => {
    const amount = usdWalletAmountFromInput("19446", WalletCurrency.Usdt)

    expect(amount).toBeInstanceOf(USDTAmount)
    expect((amount as USDTAmount).asSmallestUnits()).toBe("194460000")
    expect((amount as USDTAmount).asNumber()).toBe("194.460000")
    expect((amount as USDTAmount).toIbex()).toBe(194.46)
  })

  it("converts small USDT cent inputs to micro-USDT", () => {
    const amount = usdWalletAmountFromInput("30", WalletCurrency.Usdt)

    expect(amount).toBeInstanceOf(USDTAmount)
    expect((amount as USDTAmount).asSmallestUnits()).toBe("300000")
    expect((amount as USDTAmount).asNumber()).toBe("0.300000")
    expect((amount as USDTAmount).toIbex()).toBe(0.3)
  })

  it("rejects BTC", () => {
    const amount = usdWalletAmountFromInput("19446", WalletCurrency.Btc)

    expect(amount).toBeInstanceOf(Error)
  })
})
