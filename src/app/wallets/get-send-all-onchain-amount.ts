import { USDAmount } from "@domain/shared"

import Ibex from "@services/ibex/client"
import { IbexError } from "@services/ibex/errors"
import { baseLogger } from "@services/logger"

// #270: `onChainPaymentSendAll` handed IBEX the entire wallet balance, and IBEX
// charges the on-chain fee on top of the amount it forwards. A full-balance
// request therefore either fails at the rail or leaves dust behind instead of
// sweeping the wallet. Estimate the fee for this payout and subtract it so the
// sweep lands.
//
// A failed estimate is not a reason to refuse the send: every branch below
// returns a usable amount, and the caller keeps the pre-existing behaviour
// (whole balance) when the rail has nothing to say about the fee.
export const getSendAllOnChainAmount = async ({
  amount,
  address,
}: {
  amount: USDAmount
  address: OnChainAddress
}): Promise<USDAmount> => {
  const resp = await Ibex.estimateOnchainFee(amount, address)
  if (resp instanceof IbexError) {
    baseLogger.warn(
      { address, message: resp.message },
      "Onchain fee estimate unavailable for sendAll; sweeping the full balance",
    )
    return amount
  }

  const fee = resp.fee === undefined ? Number.NaN : Number(resp.fee)
  if (!Number.isFinite(fee) || fee <= 0) {
    baseLogger.warn(
      { address, fee: resp.fee },
      "Onchain fee estimate returned no fee for sendAll; sweeping the full balance",
    )
    return amount
  }

  const feeAmount = USDAmount.dollars(fee)
  if (feeAmount instanceof Error) {
    baseLogger.warn(
      { address, fee, message: feeAmount.message },
      "Could not parse the onchain fee estimate for sendAll; sweeping the full balance",
    )
    return amount
  }

  // A fee that eats the whole balance is not a sendable sweep: sending
  // `amount - fee` would be zero or negative, which the rail refuses anyway.
  if (!amount.isGreaterThan(feeAmount)) {
    baseLogger.warn(
      { address, fee },
      "Onchain fee covers the whole balance for sendAll; nothing left to sweep",
    )
    return amount
  }

  return amount.subtract(feeAmount)
}
