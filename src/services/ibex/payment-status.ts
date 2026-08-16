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
 *
 * The 200 also carries two failure codes — a top-level `failureReason` and
 * `transaction.payment.failureId`, both integers defaulting to 0. They are the
 * only corroboration available for a top-level `status: 3`, and that is exactly
 * what they are used for below.
 */
export type IbexPaymentStatusResponse = {
  status?: number | null
  failureReason?: number | string | null
  hash?: unknown
  transaction?: {
    id?: unknown
    accountId?: unknown
    payment?: {
      hash?: unknown
      statusId?: number | null
      failureId?: number | string | null
      status?: { id?: number | null } | null
    } | null
  } | null
}

/**
 * The `payToLnurl` (201) shape is NOT the same dialect: per the generated
 * schema it carries no top-level `status` and no `transaction.payment.status`
 * object — only `transaction.payment.statusId`, whose documented example is 0,
 * alongside a top-level `settleDateUtc` (example 1668544241, a creation-time
 * echo — see the reader) and `hash`. Two of the three fields the payInvoiceV2
 * reader looks at are structurally absent here, so this endpoint gets its own
 * reader below.
 */
export type IbexLnurlPayStatusResponse = {
  /**
   * Declared because it is on the wire, NOT because it is read: the vendor's
   * documented example populates it with the transaction's creation time on a
   * payment that has not settled. See the reader below — it is settlement
   * evidence for nothing.
   */
  settleDateUtc?: unknown
  hash?: unknown
  transaction?: {
    id?: unknown
    accountId?: unknown
    payment?: {
      hash?: unknown
      settleDateUtc?: unknown
      statusId?: number | null
      // No `failureId` here on purpose: the payToLnurl 201 declares it with an
      // EMPTY schema (it deserialises as `unknown`), so it can corroborate
      // nothing. This reader has no top-level `status` to corroborate anyway.
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

/**
 * Whether IBEX stamped a real settlement date on the payment.
 *
 * Presence is the entire question — no caller needs the instant — so this
 * returns a boolean rather than a timestamp. The two accepted serialisations
 * normalise to different UNITS (the integer form is epoch seconds, the ISO
 * string parses to milliseconds), and handing that back from a helper whose
 * name promises a timestamp is a trap for the next caller who actually uses
 * the number.
 *
 * Two serialisations have to be accepted. The payToLnurl 201 declares the
 * top-level `settleDateUtc` as an integer epoch (example 1668544241) whose
 * `default: 0` means "not settled"; the payment-level `settleDateUtc` — the
 * only one this module reads, see the reader below — has no declared type at
 * all, and every payment-level date field this vendor DOES declare is an ISO
 * string (`creationDateUtc`: "2023-07-06T14:51:59.389565Z"). Accepting numbers
 * only would leave the payment-level read dead for the string form.
 *
 * Both forms are required to resolve to an epoch > 0, which also rejects this
 * vendor's zero-date sentinel "0001-01-01T00:00:00Z" (it parses to a large
 * NEGATIVE epoch) the same way the integer 0 is rejected.
 */
const hasSettleDate = (value: unknown): boolean => {
  if (typeof value === "number") return Number.isFinite(value) && value > 0
  if (typeof value !== "string") return false
  const trimmed = value.trim()
  if (trimmed === "") return false
  // An all-digit string is a stringified epoch, NOT a date to parse. Handing
  // one to Date.parse inverts the check in both directions: Date.parse("0")
  // is 946713600000 (V8 reads a bare "0" as the year 2000), so the unset
  // sentinel would read as settled, while a real epoch like "1668544241"
  // parses as a year and is rejected. Coerce numerically first.
  if (/^[+-]?\d+$/.test(trimmed)) {
    const epoch = Number(trimmed)
    return Number.isFinite(epoch) && epoch > 0
  }
  const parsed = Date.parse(trimmed)
  return Number.isFinite(parsed) && parsed > 0
}

/**
 * IBEX's failure codes (`failureReason` at the top level, `failureId` on the
 * payment) default to 0 — "no failure". A code above 0 is IBEX naming a reason
 * the payment failed, and is the only corroboration available for a top-level
 * `status: 3`.
 *
 * The declared type admits strings as well as numbers, and a string reason can
 * be NAMED rather than numeric ("NO_ROUTE"). A named reason is IBEX naming a
 * failure exactly as much as an integer code is, so it must not be coerced
 * through `Number()` into a NaN that reads as "no corroboration" — that would
 * report a definitively failed send as `pending`, which `withPaymentIdempotency`
 * then caches for 24h under the same key.
 *
 * Only an explicit zero says "no failure": "", "0", "0.0", "-0". A string that
 * parses as a number is held to the same finite-and-`> 0` rule as the number
 * branch — a negative or infinite code is malformed, not a named reason, and
 * malformed input must never corroborate a top-level FAILED.
 */
const reportsFailureCode = (value: unknown): boolean => {
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (trimmed === "") return false
    const numeric = Number(trimmed)
    return Number.isNaN(numeric) ? true : Number.isFinite(numeric) && numeric > 0
  }
  return typeof value === "number" && Number.isFinite(value) && value > 0
}

const identityAttributes = (
  response: IbexPaymentStatusResponse | IbexLnurlPayStatusResponse | null | undefined,
) => {
  const asString = (value: unknown) =>
    typeof value === "string" && value ? value : undefined
  return {
    "ibex.transaction.id": asString(response?.transaction?.id),
    // payInvoiceV2 puts the payment hash on `transaction.payment.hash`;
    // payToLnurl leaves that field's schema empty and carries the hash at the
    // TOP level instead. Reading only the first shape hands an operator paged
    // on an unreadable LNURL response every identifier EXCEPT the one that
    // names the payment.
    "ibex.payment.hash":
      asString(response?.transaction?.payment?.hash) ?? asString(response?.hash),
    "ibex.account.id": asString(response?.transaction?.accountId),
  }
}

/**
 * Map an IBEX `payInvoiceV2` response to a payment status.
 *
 * Precedence: the payment-level fields (`transaction.payment.status.id`, then
 * `transaction.payment.statusId`) decide the outcome whenever either reports a
 * recognised id. Only if BOTH are unreadable do we fall back to the top-level
 * `status`, which is the least corroborated of the three (the only one with no
 * sibling `name` in the schema to confirm its enum) and is only ever read in
 * the anomalous context where the payment-level fields said nothing. That is
 * the worst possible place to invent a terminal outcome, in EITHER direction:
 *
 *  - Never `Success` from a lone top-level 2. Inventing a settled send is the
 *    headline bug this module exists to close.
 *  - Never `Failure` from a lone top-level 3 either. Telling a user "failed"
 *    for a payment IBEX may in fact have made sends them back to retry with a
 *    fresh idempotency key — the double-pay hole `withPaymentIdempotency`
 *    (#478) exists to close, and the same hazard the Pending choice in
 *    `paymentSendStatusOrPending` is argued from. A top-level 3 is therefore
 *    accepted only when IBEX also names a failure code (`failureReason` or
 *    `transaction.payment.failureId` > 0); uncorroborated, it is unconfirmed.
 *  - Pending needs no gate: it is the same outcome the unconfirmed path
 *    reports anyway, so reading it commits to nothing.
 *
 * Returns `UnconfirmedIbexPayment` when no field can settle the question, so
 * callers can record the anomaly instead of silently inventing an outcome.
 *
 * SEVERITY: Warn, not Critical — and deliberately the same level the LNURL
 * reader uses, because the evidence behind both is the same: no real
 * payInvoiceV2 200 has been captured on TEST either. The committed fixture
 * (test/flash/mocks/ibex/pay-invoice.ts) is the vendor's openapi example copied
 * verbatim, not an observation, and the pre-PR intraledger code read the
 * TOP-LEVEL `status` field alone — with a `{ status: 2 }` test fixture modelling
 * exactly that — which is direct evidence that at least one rail may populate
 * only the field this reader treats as uncorroborated. Paging on every
 * flash-to-flash send until a capture proves otherwise is not a severity, it is
 * an outage. Capture one 200 on TEST, commit it as a fixture, confirm the
 * payment-level fields are populated, then raise this to Critical.
 */
export const paymentSendStatusFromIbex = (
  response: IbexPaymentStatusResponse | null | undefined,
): PaymentSendStatus | UnconfirmedIbexPayment => {
  const payment = response?.transaction?.payment
  const paymentLevel =
    statusFromField(payment?.status?.id) ?? statusFromField(payment?.statusId)
  if (paymentLevel !== undefined) return paymentLevel

  const topLevel = statusFromField(response?.status)
  if (topLevel === PaymentSendStatus.Pending) return topLevel
  const corroboratedFailure =
    reportsFailureCode(response?.failureReason) || reportsFailureCode(payment?.failureId)
  if (topLevel === PaymentSendStatus.Failure && corroboratedFailure) return topLevel

  const candidates = [payment?.status?.id, payment?.statusId, response?.status]
  const uncorroborated = (outcome: string) =>
    `IBEX reported ${outcome} only in the top-level status field, with no payment-level corroboration (candidates: ${JSON.stringify(
      candidates,
    )})`
  return new UnconfirmedIbexPayment(
    topLevel === PaymentSendStatus.Success
      ? uncorroborated("SUCCEEDED")
      : topLevel === PaymentSendStatus.Failure
        ? uncorroborated("FAILED")
        : `No recognised payment status in IBEX response (candidates: ${JSON.stringify(
            candidates,
          )})`,
    ErrorLevel.Warn,
  )
}

/**
 * Map an IBEX `payToLnurl` (201) response to a payment status.
 *
 * Same payment-level precedence, and settlement is read ONLY from
 * payment-level evidence: a recognised `transaction.payment.status.id` /
 * `statusId`, or failing those a populated `transaction.payment.settleDateUtc`.
 *
 * The TOP-LEVEL `settleDateUtc` is deliberately not read. The vendor's own
 * documented 201 example — the only evidence anyone has for this endpoint —
 * sets it to 1668544241, which is `transaction.createdAt`
 * ("2022-11-15T20:30:41.960887Z") floored to the second, while every
 * payment-level field in the SAME example says the payment has not settled:
 * `statusId: 0`, `payment.settleDateUtc: null`, `paidMsat: 0`,
 * `payment.hash: null`. `Ibex.payToLnurl` also registers an async settlement
 * webhook (see client.ts), so a 201 is an acceptance, not a settlement.
 * Reading that field would report EVERY LNURL send as `success` regardless of
 * outcome — the "conversion successful while no funds moved" bug this module
 * exists to close, reintroduced on the one rail whose real response has never
 * been observed, and with the Warn-level record suppressed on that path by
 * design. The example is committed at test/flash/mocks/ibex/pay-to-lnurl.ts
 * and pinned by a test.
 *
 * The payment-level date survives because the same example corroborates it in
 * the other direction: it is `null` on a payment that has not settled, which is
 * what a settlement marker looks like. `hasSettleDate` accepts both the integer
 * epoch and the ISO string every payment-level date on this vendor is
 * serialised as, since that field has no declared type at all.
 *
 * OPEN: no real payToLnurl response has been captured on TEST yet, so the
 * settle-date rule is still schema-derived rather than observed and the
 * residual "no status, no settle date" case — the documented example's own
 * shape — is raised at Warn rather than Critical: we do not page on what may
 * well be this endpoint's happy path. Capture a response, commit it beside the
 * example fixture, then confirm both the rule and the severity.
 */
export const paymentSendStatusFromIbexLnurlPay = (
  response: IbexLnurlPayStatusResponse | null | undefined,
): PaymentSendStatus | UnconfirmedIbexPayment => {
  const payment = response?.transaction?.payment
  const paymentLevel =
    statusFromField(payment?.status?.id) ?? statusFromField(payment?.statusId)
  if (paymentLevel !== undefined) return paymentLevel

  if (hasSettleDate(payment?.settleDateUtc)) return PaymentSendStatus.Success

  return new UnconfirmedIbexPayment(
    `No recognised payment status and no payment-level settle date in IBEX payToLnurl response (candidates: ${JSON.stringify(
      [payment?.status?.id, payment?.statusId, payment?.settleDateUtc],
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
    // The error carries its own severity. Both readers currently raise Warn —
    // neither endpoint has a captured response to justify paging on an
    // unreadable one — but the level travels on the error so raising either
    // reader (once a capture lands) needs no change here. Hardcoding a level
    // would make that constructor argument silently dead.
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
 * Pending is what the LN resolvers' inline switches produced for these
 * responses; intraledger previously returned an `UnexpectedIbexResponse` here
 * — a GraphQL error, rendered as "failed" — and now reports Pending. That is a
 * deliberate, user-visible contract change on the flash-to-flash rail, called
 * out in the PR body and sequenced behind the client fix (flash-mobile#699)
 * that makes the app render `pending` honestly instead of as a completed
 * conversion. Do not treat it as an incidental side effect of the refactor.
 *
 * Pending is the choice for all four call sites because
 * `withPaymentIdempotency` caches only a definitive PaymentSendStatus:
 * returning an error here would leave the one case where we do not know
 * whether funds moved as the one case a same-key retry could pay twice. What
 * changes for the LN rails is that the anomaly is no longer invisible, and
 * that a status IBEX *did* report can no longer be missed — see
 * paymentSendStatusFromIbex.
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
