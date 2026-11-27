import { UnexpectedIbexResponse } from "./errors"

/**
 * IBEX's on-chain fee estimate names the fee twice: `feeSat` in sats and `fee`
 * in the sending wallet's currency, in whole dollars. `0.41` is forty-one
 * cents. Observed on production for a USD and a USDT wallet:
 * `{ "fee": 0.409916881285, "feeSat": 686 }`.
 *
 * The GraphQL fee fields are `FractionalCentAmount`, and clients read them as
 * cents. Passing `fee` through unscaled made a 41 cent fee read as 0.41 of a
 * cent, which a client shows as $0.00. Every resolver that returns this fee
 * goes through here so the scale lives in one place.
 */
export const onChainFeeCentsFromIbex = (resp: {
  fee?: unknown
}): number | UnexpectedIbexResponse => {
  const { fee } = resp
  if (fee === undefined || fee === null) {
    return new UnexpectedIbexResponse("Missing fee field")
  }
  if (typeof fee !== "number" || !Number.isFinite(fee) || fee < 0) {
    return new UnexpectedIbexResponse("Invalid fee field")
  }
  // Six decimals of a cent keeps IBEX's precision and drops float noise from
  // the multiplication (0.57 * 100 is 56.99999999999999).
  return Number((fee * 100).toFixed(6))
}
