import {
  amountMsatFromUsdWalletAmount,
  IBEX_LNURL_PAY_AMOUNT_MAX_MSAT,
  MSATS_PER_SAT,
  validateLnurlPayAmountMsat,
} from "@app/payments/lnurl-pay"
import { UnknownDealerPriceServiceError } from "@domain/dealer-price"
import { InvalidLnurlAmountError } from "@domain/errors"
import { paymentAmountFromNumber, USDTAmount, WalletCurrency } from "@domain/shared"

describe("amountMsatFromUsdWalletAmount", () => {
  it("converts USDT wallet cents to whole-satoshi millisatoshis using dealer sell pricing", async () => {
    const amount = USDTAmount.usdCents("19446") as USDTAmount
    const btcFromUsd = jest.fn(async (usdAmount) => {
      expect(usdAmount.amount).toBe(19446n)
      expect(usdAmount.currency).toBe(WalletCurrency.Usd)
      return paymentAmountFromNumber({
        amount: 1234,
        currency: WalletCurrency.Btc,
      }) as BtcPaymentAmount
    })

    const result = await amountMsatFromUsdWalletAmount({ amount, btcFromUsd })

    expect(result).toBe(1_234_000)
    expect(btcFromUsd).toHaveBeenCalledTimes(1)
  })

  it("converts dealer satoshis to millisatoshis", async () => {
    const amount = USDTAmount.usdCents("500") as USDTAmount
    const btcFromUsd = jest.fn(
      async () =>
        paymentAmountFromNumber({
          amount: 42,
          currency: WalletCurrency.Btc,
        }) as BtcPaymentAmount,
    )

    const result = await amountMsatFromUsdWalletAmount({ amount, btcFromUsd })

    expect(result).toBe(42 * MSATS_PER_SAT)
  })

  it("propagates dealer-price errors", async () => {
    const amount = USDTAmount.usdCents("500") as USDTAmount
    const error = new UnknownDealerPriceServiceError("dealer unavailable")
    const btcFromUsd = jest.fn(async () => error)

    const result = await amountMsatFromUsdWalletAmount({ amount, btcFromUsd })

    expect(result).toBe(error)
  })
})

describe("validateLnurlPayAmountMsat", () => {
  it("accepts positive whole-satoshi millisatoshis inside LNURL bounds", () => {
    const result = validateLnurlPayAmountMsat({
      amountMsat: 10_000 as MilliSatoshis,
      minSendable: 1_000,
      maxSendable: 20_000,
    })

    expect(result).toBe(true)
  })

  it("rejects sub-satoshi millisatoshis", () => {
    const result = validateLnurlPayAmountMsat({
      amountMsat: 1_500 as MilliSatoshis,
      minSendable: 1_000,
      maxSendable: 20_000,
    })

    expect(result).toBeInstanceOf(InvalidLnurlAmountError)
  })

  it("rejects values below minSendable after rounding", () => {
    const result = validateLnurlPayAmountMsat({
      amountMsat: 1_000 as MilliSatoshis,
      minSendable: 2_000,
      maxSendable: 20_000,
    })

    expect(result).toBeInstanceOf(InvalidLnurlAmountError)
  })

  it("rejects values above maxSendable after rounding", () => {
    const result = validateLnurlPayAmountMsat({
      amountMsat: 21_000 as MilliSatoshis,
      minSendable: 1_000,
      maxSendable: 20_000,
    })

    expect(result).toBeInstanceOf(InvalidLnurlAmountError)
  })

  it("rejects values above the IBEX int32 request limit", () => {
    const result = validateLnurlPayAmountMsat({
      amountMsat: (IBEX_LNURL_PAY_AMOUNT_MAX_MSAT + 1) as MilliSatoshis,
      minSendable: 1_000,
      maxSendable: IBEX_LNURL_PAY_AMOUNT_MAX_MSAT + 2,
    })

    expect(result).toBeInstanceOf(InvalidLnurlAmountError)
  })
})
