import { toMilliSatsFromNumber } from "@domain/bitcoin"
import { InvalidLnurlAmountError } from "@domain/errors"
import { checkedToUsdPaymentAmount, USDTAmount, WalletCurrency } from "@domain/shared"

import { UsdWalletAmount } from "@app/wallets/usd-wallet-amount"

export const MSATS_PER_SAT = 1000
export const IBEX_LNURL_PAY_AMOUNT_MAX_MSAT = 2_147_483_647

export const amountMsatFromUsdWalletAmount = async ({
  amount,
  btcFromUsd,
}: {
  amount: UsdWalletAmount
  btcFromUsd: IDealerPriceService["getSatsFromCentsForImmediateSell"]
}): Promise<MilliSatoshis | ApplicationError> => {
  const usdCents = amount instanceof USDTAmount ? amount.asUsdCents() : amount.asCents()

  const usdPaymentAmount = checkedToUsdPaymentAmount(Number(usdCents), WalletCurrency.Usd)
  if (usdPaymentAmount instanceof Error) return usdPaymentAmount

  const sats = await btcFromUsd(usdPaymentAmount)
  if (sats instanceof Error) return sats

  const wholeSats = Math.floor(Number(sats.amount))
  const msats = wholeSats * MSATS_PER_SAT

  return toMilliSatsFromNumber(msats)
}

export const validateLnurlPayAmountMsat = ({
  amountMsat,
  minSendable,
  maxSendable,
}: {
  amountMsat: MilliSatoshis
  minSendable: number
  maxSendable: number
}): true | ValidationError => {
  if (!Number.isInteger(amountMsat) || amountMsat <= 0) {
    return new InvalidLnurlAmountError("LNURL amount must be positive integer msats")
  }

  if (amountMsat % MSATS_PER_SAT !== 0) {
    return new InvalidLnurlAmountError("LNURL amount must be a whole-satoshi amount")
  }

  if (amountMsat > IBEX_LNURL_PAY_AMOUNT_MAX_MSAT) {
    return new InvalidLnurlAmountError("LNURL amount exceeds IBEX int32 limit")
  }

  if (amountMsat < minSendable || amountMsat > maxSendable) {
    return new InvalidLnurlAmountError(
      "LNURL amount outside minSendable/maxSendable bounds",
    )
  }

  return true
}
