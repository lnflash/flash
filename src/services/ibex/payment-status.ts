import { PaymentSendStatus } from "@domain/bitcoin/lightning"
import { ErrorLevel } from "@domain/shared"
import { recordExceptionInCurrentSpan } from "@services/tracing"

import { UnconfirmedIbexPayment } from "./errors"

/**
 * IBEX's payment status ids, from the vendor's own table:
 *   https://docs.poweredbyibex.io/reference/flow-1#payment-status
 *   (was docs.ibexmercado.com/reference/flow-1#payment-status before the 301)
 *
 *   0  UNKNOWN    "Unknown state"
 *   1  IN_FLIGHT  "Payment is still in flight."
 *   2  SUCCEEDED  "Payment completed successfully."
 *   3  FAILED     "Payment failed to settle"
 *
 * 0 is a real, documented id — but it reports no outcome, and it is anyway
 * indistinguishable from an unset field: every integer in the generated IBEX
 * schema declares `default: 0`, so an omitted status deserialises to 0 too.
 * Either way 0 says nothing about whether money moved, which is why it is
 * deliberately absent from `RECOGNISED_IDS`: a 0 in the first field we look at
 * must not mask a real status reported further down the same response.
 *
 * (An earlier reading in send-intraledger mapped 0 to "Invoice already paid".
 * That was wrong against the table above and has been removed — do not
 * reintroduce it without a vendor doc change to cite.)
 */
export const IbexPaymentStatusId = {
  Unknown: 0,
  InFlight: 1,
  Succeeded: 2,
  Failed: 3,
} as const

const RECOGNISED_IDS: number[] = [
  IbexPaymentStatusId.InFlight,
  IbexPaymentStatusId.Succeeded,
  IbexPaymentStatusId.Failed,
]

/**
 * The `payInvoiceV2` shape: the payment state is reported in up to three
 * places — a top-level `status`, and on the transaction's payment both
 * `statusId` and a nested `status.id`. Which ones are populated varies by
 * response, so we read them in precedence order rather than `??`-chaining
 * fields that can legitimately be 0.
 */
export type IbexPaymentStatusResponse = {
  status?: number | null
  transaction?: {
    id?: unknown
    accountId?: unknown
    payment?: {
      hash?: unknown
      statusId?: number | null
      status?: { id?: number | null } | null
    } | null
  } | null
}

/**
 * The `payToLnurl` (201) shape is NOT the same dialect: per the generated
 * schema it carries no top-level `status` and no `transaction.payment.status`
 * object — only `transaction.payment.statusId`, whose documented example is 0,
 * alongside a top-level `settleDateUtc` (example 1668544241) and `hash`. Two of
 * the three fields the payInvoiceV2 reader looks at are structurally absent
 * here, so this endpoint gets its own reader below.
 */
export type IbexLnurlPayStatusResponse = {
  settleDateUtc?: unknown
  hash?: unknown
  transaction?: {
    id?: unknown
    accountId?: unknown
    payment?: {
      hash?: unknown
      settleDateUtc?: unknown
      statusId?: number | null
      status?: { id?: number | null } | null
    } | null
  } | null
}

const statusFromField = (value: unknown): PaymentSendStatus | undefined => {
  if (typeof value !== "number" || !RECOGNISED_IDS.includes(value)) return undefined
  switch (value) {
    case IbexPaymentStatusId.InFlight:
      return PaymentSendStatus.Pending
    case IbexPaymentStatusId.Succeeded:
      return PaymentSendStatus.Success
    case IbexPaymentStatusId.Failed:
      return PaymentSendStatus.Failure
    default:
      return undefined
  }
}

// Populated only when IBEX has actually settled the payment (the schema's
// `default: 0` means "not settled" arrives as 0, and the field is null on an
// in-flight payInvoiceV2 response).
const settledAt = (value: unknown): number | undefined =>
  typeof value === "number" && value > 0 ? value : undefined

const identityAttributes = (
  response: IbexPaymentStatusResponse | IbexLnurlPayStatusResponse | null | undefined,
) => {
  const asString = (value: unknown) =>
    typeof value === "string" && value ? value : undefined
  return {
    "ibex.transaction.id": asString(response?.transaction?.id),
    "ibex.payment.hash": asString(response?.transaction?.payment?.hash),
    "ibex.account.id": asString(response?.transaction?.accountId),
  }
}

/**
 * Map an IBEX `payInvoiceV2` response to a payment status.
 *
 * Precedence: the payment-level fields (`transaction.payment.status.id`, then
 * `transaction.payment.statusId`) decide the outcome whenever either reports a
 * recognised id. Only if BOTH are unreadable do we fall back to the top-level
 * `status` — and then for Pending/Failure only. Settlement is never taken from
 * the top-level field: it is the least corroborated of the three (the only one
 * with no sibling `name` in the schema to confirm its enum), and the context it
 * would fire in — both payment-level fields unreadable — is the worst possible
 * one in which to upgrade a payment to "settled".
 *
 * Returns `UnconfirmedIbexPayment` when no field can settle the question, so
 * callers can record the anomaly instead of silently inventing an outcome.
 * Note what this deliberately never returns from a lone top-level 2: `Success`.
 */
export const paymentSendStatusFromIbex = (
  response: IbexPaymentStatusResponse | null | undefined,
): PaymentSendStatus | UnconfirmedIbexPayment => {
  const payment = response?.transaction?.payment
  const paymentLevel =
    statusFromField(payment?.status?.id) ?? statusFromField(payment?.statusId)
  if (paymentLevel !== undefined) return paymentLevel

  const topLevel = statusFromField(response?.status)
  if (topLevel === PaymentSendStatus.Pending || topLevel === PaymentSendStatus.Failure) {
    return topLevel
  }

  const candidates = [payment?.status?.id, payment?.statusId, response?.status]
  return new UnconfirmedIbexPayment(
    topLevel === PaymentSendStatus.Success
      ? `IBEX reported SUCCEEDED only in the top-level status field, with no payment-level corroboration (candidates: ${JSON.stringify(
          candidates,
        )})`
      : `No recognised payment status in IBEX response (candidates: ${JSON.stringify(
          candidates,
        )})`,
  )
}

/**
 * Map an IBEX `payToLnurl` (201) response to a payment status.
 *
 * Same payment-level precedence, but this endpoint reports settlement with a
 * `settleDateUtc` timestamp rather than a status enum — its documented
 * `statusId` example is 0 — so a populated settle date is read as settlement
 * once the status fields have come up empty. That is an explicit signal from
 * IBEX, not an inference from silence.
 *
 * The residual "no status, no settle date" case is raised at Warn rather than
 * Critical: no real payToLnurl response has been captured on TEST yet, so we do
 * not page on what may well be this endpoint's happy path. Raise it to Critical
 * once a captured response proves the field is populated in normal operation.
 */
export const paymentSendStatusFromIbexLnurlPay = (
  response: IbexLnurlPayStatusResponse | null | undefined,
): PaymentSendStatus | UnconfirmedIbexPayment => {
  const payment = response?.transaction?.payment
  const paymentLevel =
    statusFromField(payment?.status?.id) ?? statusFromField(payment?.statusId)
  if (paymentLevel !== undefined) return paymentLevel

  const settleDateUtc =
    settledAt(response?.settleDateUtc) ?? settledAt(payment?.settleDateUtc)
  if (settleDateUtc !== undefined) return PaymentSendStatus.Success

  return new UnconfirmedIbexPayment(
    `No recognised payment status and no settle date in IBEX payToLnurl response (candidates: ${JSON.stringify(
      [payment?.status?.id, payment?.statusId, response?.settleDateUtc],
    )})`,
    ErrorLevel.Warn,
  )
}

const recordUnconfirmed = (
  error: UnconfirmedIbexPayment,
  response: IbexPaymentStatusResponse | IbexLnurlPayStatusResponse | null | undefined,
): void => {
  recordExceptionInCurrentSpan({
    error,
    // The error carries its own severity — the payInvoiceV2 reader raises
    // Critical, the LNURL one Warn. Hardcoding a level here would make that
    // constructor argument silently dead.
    level: error.level,
    fallbackMsg: "IBEX payment response carried no recognised status",
    // Without these an operator woken by "money may or may not have moved" has
    // to trace-hop to the child ibex-client span before they can even name the
    // payment.
    attributes: identityAttributes(response),
  })
}

/**
 * What the `payInvoiceV2` send resolvers call: the mapping above, with an
 * unreadable response recorded and reported as still in flight.
 *
 * "Pending" is what the previous inline switches produced for these responses
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
    recordUnconfirmed(status, response)
    return PaymentSendStatus.Pending
  }
  return status
}

/** The `payToLnurl` counterpart of `paymentSendStatusOrPending`. */
export const lnurlPaymentSendStatusOrPending = (
  response: IbexLnurlPayStatusResponse | null | undefined,
): PaymentSendStatus => {
  const status = paymentSendStatusFromIbexLnurlPay(response)
  if (status instanceof UnconfirmedIbexPayment) {
    recordUnconfirmed(status, response)
    return PaymentSendStatus.Pending
  }
  return status
}
