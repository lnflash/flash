import { getOnChainBtcDenominatedSendMarginBps } from "@config"

import { usdCentsPerSatMidPrice } from "@app/prices/mid-price"

import { InvalidSendAmountError } from "@domain/payments/errors"
import { PriceNotAvailableError } from "@domain/price"

import { addAttributesToCurrentSpan } from "@services/tracing"

export type CentsForSats = {
  cents: number
  marginBps: number
}

/**
 * How many US cents a Cash wallet has to send on-chain so that the recipient
 * gets AT LEAST `sats`.
 *
 * Why this exists: a payment request can name its amount in bitcoin (every
 * merchant invoice and POS checkout does), but IBEX sends from a dollar wallet
 * in dollars only: `sendToAddressV2` takes "amount in the wallet's currency".
 * There is no way to ask for an exact number of sats. So the sats are priced at
 * the mid rate and the dollar amount is pushed UP, never down:
 *
 *   cents = ceil(sats x centsPerSat x (1 + margin))
 *
 * The margin (`onChainWallet.btcDenominatedSendMarginBps`, default 50 = 0.5%)
 * covers the price moving between this quote and IBEX executing the send, and
 * any difference between the mid rate and the rate IBEX converts at. That
 * second part has not been measured, which is why the margin is a setting.
 *
 * The cost of the margin is that the recipient receives slightly MORE than
 * asked. That is the intended direction: a bill that must be paid in full (a
 * POS checkout confirms only on the full amount) is covered, and the excess
 * goes to the recipient, not to Flash. It is not a fee and must not be shown as
 * one.
 */
export const usdCentsToDeliverSats = async (
  sats: number,
): Promise<CentsForSats | ApplicationError> => {
  if (!Number.isSafeInteger(sats) || sats <= 0) {
    return new InvalidSendAmountError("Amount must be a whole number of sats above zero")
  }

  const centsPerSat = await usdCentsPerSatMidPrice()
  if (centsPerSat instanceof Error) return centsPerSat
  if (!Number.isFinite(centsPerSat) || centsPerSat <= 0) {
    return new PriceNotAvailableError("No usable BTC/USD price for an on-chain send")
  }

  const marginBps = getOnChainBtcDenominatedSendMarginBps()
  const cents = Math.ceil(sats * centsPerSat * (1 + marginBps / 10_000))
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    return new InvalidSendAmountError("Amount is too large to convert")
  }

  // Strings: addAttributesToCurrentSpan drops falsy values, and these are the
  // numbers a later "did the recipient get the full amount" check reads.
  addAttributesToCurrentSpan({
    "onchainBtcDenominated.sats": String(sats),
    "onchainBtcDenominated.centsPerSat": String(centsPerSat),
    "onchainBtcDenominated.marginBps": String(marginBps),
    "onchainBtcDenominated.cents": String(cents),
  })

  return { cents, marginBps }
}
