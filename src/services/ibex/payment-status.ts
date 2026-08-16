import { PaymentSendStatus } from "@domain/bitcoin/lightning"
import { ErrorLevel } from "@domain/shared"
import { recordExceptionInCurrentSpan } from "@services/tracing"

import { UnconfirmedIbexPayment } from "./errors"

// IBEX's pay-invoice response reports the payment state in up to three places
// (see the generated schema for `PayInvoiceV2`): a top-level `status`, and on
// the transaction's payment both `statusId` and a nested `status.id`. Which
// ones are populated varies by response, and unset integer fields arrive as 0
// rather than being omitted — so we take the first RECOGNISED id rather than
// the first present one. Reading only `status.id`, or `??`-chaining fields
// that can legitimately be 0, can miss a status IBEX did report.
export type IbexPaymentStatusResponse = {
  status?: number | null
  transaction?: {
    payment?: {
      statusId?: number | null
      status?: { id?: number | null } | null
    } | null
  } | null
}

export const IbexPaymentStatusId = {
  InFlight: 1,
  Succeeded: 2,
  Failed: 3,
} as const

const recognised: number[] = Object.values(IbexPaymentStatusId)

/**
 * Map an IBEX pay-invoice response to a payment status.
 *
 * Returns `UnconfirmedIbexPayment` when the response carries no recognised
 * status, so callers can record the anomaly instead of silently inventing an
 * outcome. Note what this deliberately never returns: `Success`. Only an
 * explicit "succeeded" id is reported as a settled payment.
 */
export const paymentSendStatusFromIbex = (
  response: IbexPaymentStatusResponse | null | undefined,
): PaymentSendStatus | UnconfirmedIbexPayment => {
  const payment = response?.transaction?.payment
  const candidates = [payment?.status?.id, payment?.statusId, response?.status]

  const statusId = candidates.find(
    (id): id is number => typeof id === "number" && recognised.includes(id),
  )

  switch (statusId) {
    case IbexPaymentStatusId.InFlight:
      return PaymentSendStatus.Pending
    case IbexPaymentStatusId.Succeeded:
      return PaymentSendStatus.Success
    case IbexPaymentStatusId.Failed:
      return PaymentSendStatus.Failure
    default:
      return new UnconfirmedIbexPayment(
        `No recognised payment status in IBEX response (candidates: ${JSON.stringify(
          candidates,
        )})`,
      )
  }
}

/**
 * What the send resolvers call: the mapping above, with an unreadable response
 * recorded and reported as still in flight.
 *
 * "Pending" is what the previous inline switch produced for these responses
 * too, and it is kept deliberately: `withPaymentIdempotency` caches only a
 * definitive PaymentSendStatus, so returning an error here would leave the one
 * case where we do not know whether funds moved as the one case a same-key
 * retry could pay twice. What changes is that the anomaly is no longer
 * invisible, and that a status IBEX *did* report can no longer be missed —
 * see paymentSendStatusFromIbex.
 */
export const paymentSendStatusOrPending = (
  response: IbexPaymentStatusResponse | null | undefined,
): PaymentSendStatus => {
  const status = paymentSendStatusFromIbex(response)
  if (status instanceof UnconfirmedIbexPayment) {
    recordExceptionInCurrentSpan({
      error: status,
      level: ErrorLevel.Critical,
      fallbackMsg: "IBEX payment response carried no recognised status",
    })
    return PaymentSendStatus.Pending
  }
  return status
}
