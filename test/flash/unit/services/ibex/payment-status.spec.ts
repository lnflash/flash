jest.mock("@services/tracing", () => ({
  addAttributesToCurrentSpan: jest.fn(),
  addEventToCurrentSpan: jest.fn(),
  recordExceptionInCurrentSpan: jest.fn(),
}))

import { PaymentSendStatus } from "@domain/bitcoin/lightning"
import { ErrorLevel } from "@domain/shared"
import { UnconfirmedIbexPayment } from "@services/ibex/errors"
import {
  UNCONFIRMED_SPAN_EVENT,
  lnurlPaymentSendStatusOrPending,
  paymentSendStatusFromIbex,
  paymentSendStatusFromIbexLnurlPay,
  paymentSendStatusOrPending,
} from "@services/ibex/payment-status"
import {
  addAttributesToCurrentSpan,
  addEventToCurrentSpan,
  recordExceptionInCurrentSpan,
} from "@services/tracing"

// The vendor's own documented response bodies, committed verbatim. Neither is a
// live capture — that is the point: these are the only evidence either reader
// has, so the readers are asserted against them rather than against shapes we
// imagined.
import * as payInvoiceMock from "test/flash/mocks/ibex/pay-invoice"
import * as payToLnurlMock from "test/flash/mocks/ibex/pay-to-lnurl"

const recordMock = recordExceptionInCurrentSpan as jest.Mock
const attrMock = addAttributesToCurrentSpan as jest.Mock
const eventMock = addEventToCurrentSpan as jest.Mock

const withNestedStatus = (id: number) => ({
  transaction: { payment: { status: { id } } },
})

/**
 * An unreadable response is recorded on exactly one of two channels, never
 * both and never neither — see recordUnconfirmed. `recordExceptionInCurrentSpan`
 * ends in an unconditional `span.setStatus({ code: ERROR })`, so the channel,
 * not the ErrorLevel, is what decides whether the span goes red. This helper
 * asserts the "exactly one" invariant and hands back which channel fired so the
 * tests below can pin the choice per response shape.
 */
const soleRecord = () => {
  expect(recordMock.mock.calls.length + eventMock.mock.calls.length).toBe(1)

  if (recordMock.mock.calls.length === 1) {
    const [payload] = recordMock.mock.calls[0]
    return {
      loud: true as const,
      level: payload.level as ErrorLevel,
      error: payload.error as UnconfirmedIbexPayment,
      reason: (payload.error as UnconfirmedIbexPayment).message,
      attributes: payload.attributes as Record<string, unknown>,
    }
  }

  const [name, eventAttributes] = eventMock.mock.calls[0]
  expect(name).toBe(UNCONFIRMED_SPAN_EVENT)
  const spanAttributes = Object.assign({}, ...attrMock.mock.calls.map(([a]) => a))
  return {
    loud: false as const,
    level: eventAttributes["ibex.payment.unconfirmed.level"] as ErrorLevel,
    error: undefined,
    reason: eventAttributes["ibex.payment.unconfirmed.reason"] as string,
    attributes: spanAttributes as Record<string, unknown>,
  }
}

// Responses payInvoiceV2 callers cannot read an outcome from. Note `{ status: 2 }`
// and `{ status: 3 }`: a lone top-level SUCCEEDED is not settlement and a lone
// top-level FAILED is not failure — see the precedence tests below.
const unreadableResponses = [
  {},
  { status: 0 },
  { status: 2 },
  { status: 3 },
  { status: 3, failureReason: 0, transaction: { payment: { failureId: 0 } } },
  { status: 7 },
  { transaction: {} },
  { transaction: { payment: {} } },
  { transaction: { payment: { status: {} } } },
  { transaction: { payment: { statusId: 0, status: { id: 0 } } } },
  null,
  undefined,
]

beforeEach(() => {
  jest.clearAllMocks()
})

describe("paymentSendStatusFromIbex", () => {
  it("maps the recognised IBEX status ids", () => {
    expect(paymentSendStatusFromIbex(withNestedStatus(1))).toBe(PaymentSendStatus.Pending)
    expect(paymentSendStatusFromIbex(withNestedStatus(2))).toBe(PaymentSendStatus.Success)
    expect(paymentSendStatusFromIbex(withNestedStatus(3))).toBe(PaymentSendStatus.Failure)
  })

  it("reads the flat statusId when the nested status object is absent", () => {
    expect(paymentSendStatusFromIbex({ transaction: { payment: { statusId: 2 } } })).toBe(
      PaymentSendStatus.Success,
    )
  })

  it("falls back to the top-level status field for pending unconditionally", () => {
    // Pending needs no corroboration: it is the same outcome the unconfirmed
    // path reports anyway, so reading it commits to nothing.
    expect(paymentSendStatusFromIbex({ status: 1 })).toBe(PaymentSendStatus.Pending)
  })

  it("falls back to the top-level status field for failure only when IBEX names a failure code", () => {
    expect(paymentSendStatusFromIbex({ status: 3, failureReason: 2 })).toBe(
      PaymentSendStatus.Failure,
    )
    expect(
      paymentSendStatusFromIbex({
        status: 3,
        transaction: { payment: { failureId: 4 } },
      }),
    ).toBe(PaymentSendStatus.Failure)
  })

  it("never fails a payment on the top-level status field alone", () => {
    // The mirror of "never invent a settled send". Telling a user "failed" for
    // a send IBEX may in fact have made sends them back to retry with a fresh
    // idempotency key — the double-pay hole withPaymentIdempotency (#478)
    // exists to close. The top-level field is the least corroborated of the
    // three and is only ever read when both payment-level fields said nothing;
    // that argument does not stop applying when the digit is 3.
    const unconfirmed = paymentSendStatusFromIbex({ status: 3 })

    expect(unconfirmed).toBeInstanceOf(UnconfirmedIbexPayment)
    expect((unconfirmed as UnconfirmedIbexPayment).message).toMatch(
      /FAILED only in the top-level status field/i,
    )
  })

  it("treats a zeroed failure code as no corroboration", () => {
    // Every integer in the generated schema declares `default: 0`, so an unset
    // failureReason/failureId arrives as 0 — that is IBEX saying "no failure",
    // never "failed for reason zero".
    expect(
      paymentSendStatusFromIbex({
        status: 3,
        failureReason: 0,
        transaction: { payment: { failureId: 0 } },
      }),
    ).toBeInstanceOf(UnconfirmedIbexPayment)
  })

  it("skips unset (0) fields rather than reading them as unknown", () => {
    // 0 is IBEX's UNKNOWN (docs.poweredbyibex.io/reference/flow-1#payment-status)
    // and is also what an unset integer deserialises to, so a 0 in the first
    // position must not mask a real status further down the response. This is
    // what the previous `status?.id ?? statusId` chain got wrong.
    const response = { transaction: { payment: { statusId: 2, status: { id: 0 } } } }

    expect(paymentSendStatusFromIbex(response)).toBe(PaymentSendStatus.Success)
  })

  it("never settles a payment on the top-level status field alone", () => {
    // The top-level `status` is the least corroborated of the three fields (no
    // sibling `name` in the schema to confirm its enum) and the only context it
    // is ever read in is the anomalous one — both payment-level fields
    // unreadable. That is the worst possible place to upgrade a send to
    // "settled", so a lone top-level 2 is reported as unconfirmed.
    const unconfirmed = paymentSendStatusFromIbex({ status: 2 })

    expect(unconfirmed).toBeInstanceOf(UnconfirmedIbexPayment)
    expect((unconfirmed as UnconfirmedIbexPayment).message).toMatch(
      /top-level status field/i,
    )
    expect(
      paymentSendStatusFromIbex({
        status: 2,
        transaction: { payment: { statusId: 0, status: { id: 0 } } },
      }),
    ).toBeInstanceOf(UnconfirmedIbexPayment)
  })

  describe("field precedence when two recognised fields disagree", () => {
    it("prefers the payment-level nested status over the top-level status", () => {
      expect(
        paymentSendStatusFromIbex({
          status: 2,
          transaction: { payment: { status: { id: 3 } } },
        }),
      ).toBe(PaymentSendStatus.Failure)
    })

    it("prefers the payment-level nested status over the top-level status (mirror)", () => {
      expect(
        paymentSendStatusFromIbex({
          status: 3,
          transaction: { payment: { status: { id: 2 } } },
        }),
      ).toBe(PaymentSendStatus.Success)
    })

    it("prefers the nested status object over the flat statusId", () => {
      expect(
        paymentSendStatusFromIbex({
          transaction: { payment: { statusId: 2, status: { id: 3 } } },
        }),
      ).toBe(PaymentSendStatus.Failure)
      expect(
        paymentSendStatusFromIbex({
          transaction: { payment: { statusId: 3, status: { id: 2 } } },
        }),
      ).toBe(PaymentSendStatus.Success)
    })

    it("prefers the flat statusId over the top-level status", () => {
      expect(
        paymentSendStatusFromIbex({
          status: 2,
          transaction: { payment: { statusId: 3 } },
        }),
      ).toBe(PaymentSendStatus.Failure)
    })

    it("does not read a top-level FAILED past an unset payment-level statusId without a failure code", () => {
      // The shape that made this a finding: payment-level unreadable (0 is
      // unset/UNKNOWN, never an outcome) with a bare top-level 3. Uncorroborated
      // it is unconfirmed; the moment IBEX also names a failure code it is a
      // genuine failure.
      expect(
        paymentSendStatusFromIbex({
          status: 3,
          transaction: { payment: { statusId: 0 } },
        }),
      ).toBeInstanceOf(UnconfirmedIbexPayment)
      expect(
        paymentSendStatusFromIbex({
          status: 3,
          failureReason: 12,
          transaction: { payment: { statusId: 0 } },
        }),
      ).toBe(PaymentSendStatus.Failure)
    })
  })

  it("returns UnconfirmedIbexPayment when no recognised status is present", () => {
    for (const response of unreadableResponses) {
      expect(paymentSendStatusFromIbex(response)).toBeInstanceOf(UnconfirmedIbexPayment)
    }
  })

  it("raises the unreadable payInvoiceV2 case at Warn, not Critical", () => {
    // No real payInvoiceV2 200 has been captured on TEST: the committed
    // fixture is the vendor's openapi example, and the pre-#483 intraledger
    // code read the TOP-LEVEL status alone — direct evidence that a rail may
    // populate only the field this reader treats as uncorroborated. Paging on
    // every flash-to-flash send until a capture proves otherwise is an outage,
    // not a severity.
    const unconfirmed = paymentSendStatusFromIbex({}) as UnconfirmedIbexPayment

    expect(unconfirmed.level).toBe(ErrorLevel.Warn)
  })

  it("reads the vendor's documented payInvoiceV2 200 example as in-flight", () => {
    // The committed fixture populates all three status fields with IN_FLIGHT.
    // Asserting the reader against the evidence that actually exists means a
    // change to either the fixture or the precedence rules has to be deliberate.
    expect(paymentSendStatusFromIbex(payInvoiceMock.response)).toBe(
      PaymentSendStatus.Pending,
    )
  })

  describe("named (non-numeric) failure codes", () => {
    // The declared type admits strings, and a string reason can be NAMED
    // rather than numeric. Coercing "NO_ROUTE" through Number() yields NaN,
    // which used to read as "no corroboration" — reporting a definitively
    // failed send as pending, which withPaymentIdempotency then caches for 24h
    // under the same key.
    it("accepts a named failureReason as corroboration", () => {
      expect(paymentSendStatusFromIbex({ status: 3, failureReason: "NO_ROUTE" })).toBe(
        PaymentSendStatus.Failure,
      )
    })

    it("accepts a named payment-level failureId as corroboration", () => {
      expect(
        paymentSendStatusFromIbex({
          status: 3,
          transaction: { payment: { statusId: 0, failureId: "INSUFFICIENT_BALANCE" } },
        }),
      ).toBe(PaymentSendStatus.Failure)
    })

    it("accepts a numeric string code above zero", () => {
      expect(paymentSendStatusFromIbex({ status: 3, failureReason: "2" })).toBe(
        PaymentSendStatus.Failure,
      )
    })

    it("still treats an explicit zero, blank or malformed string as no corroboration", () => {
      for (const failureReason of ["0", "0.0", "-0", "", "   ", "-1", "Infinity"]) {
        expect(paymentSendStatusFromIbex({ status: 3, failureReason })).toBeInstanceOf(
          UnconfirmedIbexPayment,
        )
      }
    })
  })

  it("never reports success without an explicit success id", () => {
    for (const response of unreadableResponses) {
      expect(paymentSendStatusFromIbex(response)).not.toBe(PaymentSendStatus.Success)
    }
  })

  it("never reports failure without an explicit, corroborated failure", () => {
    // The mirror invariant. A fabricated "failed" is not a safe default: it
    // sends the user back to retry with a new idempotency key against a send
    // that may already have paid.
    for (const response of unreadableResponses) {
      expect(paymentSendStatusFromIbex(response)).not.toBe(PaymentSendStatus.Failure)
    }
  })
})

describe("paymentSendStatusOrPending", () => {
  it("passes through a recognised status", () => {
    expect(paymentSendStatusOrPending(withNestedStatus(2))).toBe(
      PaymentSendStatus.Success,
    )
    expect(paymentSendStatusOrPending(withNestedStatus(3))).toBe(
      PaymentSendStatus.Failure,
    )
  })

  it("reports an unreadable response as pending, never as settled", () => {
    // Pending keeps the result cacheable by withPaymentIdempotency, so a
    // same-key retry replays it instead of paying again — the one case where
    // we do not know whether funds moved is the last one that should re-pay.
    for (const response of unreadableResponses) {
      const status = paymentSendStatusOrPending(response)
      expect(status).toBe(PaymentSendStatus.Pending)
      expect(status).not.toBe(PaymentSendStatus.Success)
    }
  })

  it("records the anomaly exactly once, at the error's own level", () => {
    // soleRecord() asserts the "exactly once, on exactly one channel" half.
    // Collect the levels and check them after the loop so every assertion is
    // unconditional.
    const recordedLevels: ErrorLevel[] = []
    const errorOwnLevels: ErrorLevel[] = []

    for (const response of unreadableResponses) {
      jest.clearAllMocks()

      paymentSendStatusOrPending(response)

      const recorded = soleRecord()
      recordedLevels.push(recorded.level)
      // Present only on the loud channel; the level must be the error's own
      // rather than a hardcoded one, so that raising a reader's severity needs
      // no change in recordUnconfirmed.
      if (recorded.error) errorOwnLevels.push(recorded.error.level)
    }

    expect(recordedLevels).toEqual(unreadableResponses.map(() => ErrorLevel.Warn))
    expect(errorOwnLevels.length).toBeGreaterThan(0)
    expect(errorOwnLevels).toEqual(errorOwnLevels.map(() => ErrorLevel.Warn))
  })

  describe("span volume — which channel each unreadable shape earns", () => {
    // ErrorLevel does NOT decide this: recordExceptionInCurrentSpan ends in an
    // unconditional span.setStatus({ code: ERROR }) (services/tracing.ts), so a
    // Warn-level recordException still paints the span red and any trigger keyed
    // on span status rather than the error.level attribute fires on it. Marking
    // 100% of a rail's spans ERROR because its ordinary acceptance shape is
    // unreadable would bury the anomalies that matter.
    it("stays quiet — attributes + span event, no exception — when IBEX claimed nothing", () => {
      for (const response of [
        {},
        { status: 0 },
        { status: 7 },
        { transaction: { payment: {} } },
        { transaction: { payment: { statusId: 0, status: { id: 0 } } } },
        null,
        undefined,
      ]) {
        jest.clearAllMocks()

        expect(paymentSendStatusOrPending(response)).toBe(PaymentSendStatus.Pending)

        const recorded = soleRecord()
        expect(recorded.loud).toBe(false)
        expect(recorded.attributes["ibex.payment.unconfirmed"]).toBe(true)
        expect(recordMock).not.toHaveBeenCalled()
      }
    })

    it("goes loud — a recorded exception — when IBEX claimed a terminal outcome we refused", () => {
      // Here the payload disagrees with itself: a top-level SUCCEEDED/FAILED
      // that the corroboration rules would not honour. The `pending` we report
      // may be wrong in a direction that moved money, so the ERROR span status
      // that comes with recordException is earned.
      for (const [response, outcome] of [
        [{ status: 2 }, "SUCCEEDED"],
        [{ status: 3 }, "FAILED"],
        [
          { status: 3, failureReason: 0, transaction: { payment: { failureId: 0 } } },
          "FAILED",
        ],
        [{ status: 2, transaction: { payment: { statusId: 0 } } }, "SUCCEEDED"],
      ] as const) {
        jest.clearAllMocks()

        expect(paymentSendStatusOrPending(response)).toBe(PaymentSendStatus.Pending)

        const recorded = soleRecord()
        if (!recorded.loud) throw new Error("expected a recorded exception, got an event")
        expect(recorded.attributes["ibex.payment.uncorroborated_outcome"]).toBe(outcome)
        expect(recorded.error.uncorroboratedOutcome).toBe(outcome)
        expect(eventMock).not.toHaveBeenCalled()
      }
    })
  })

  it("records the identifying fields so the payment is nameable from the alert", () => {
    // Without these an operator looking at "money may or may not have moved"
    // has to trace-hop to the child ibex-client span before they can name it.
    // They must land on BOTH channels — a quiet record that cannot name the
    // payment is not a record.
    const identity = {
      "ibex.transaction.id": "dfeec8bd-b4e7-46f1-aa4a-cf4e4569df02",
      "ibex.payment.hash": "19b7ff42e048d147",
      "ibex.account.id": "eeba6152-9432-448e-b7d2-4205e5099924",
    }
    const transaction = {
      id: identity["ibex.transaction.id"],
      accountId: identity["ibex.account.id"],
      payment: { hash: identity["ibex.payment.hash"], statusId: 0 },
    }

    paymentSendStatusOrPending({ status: 0, transaction })
    expect(soleRecord()).toMatchObject({
      loud: false,
      attributes: expect.objectContaining(identity),
    })

    jest.clearAllMocks()

    paymentSendStatusOrPending({ status: 2, transaction })
    expect(soleRecord()).toMatchObject({
      loud: true,
      attributes: expect.objectContaining(identity),
    })
  })

  it("does not record anything for a recognised status", () => {
    paymentSendStatusOrPending(withNestedStatus(1))
    paymentSendStatusOrPending(withNestedStatus(2))
    paymentSendStatusOrPending(withNestedStatus(3))
    paymentSendStatusOrPending({ status: 1 })
    paymentSendStatusOrPending({ status: 3, failureReason: 2 })

    expect(recordMock).not.toHaveBeenCalled()
    expect(eventMock).not.toHaveBeenCalled()
    expect(attrMock).not.toHaveBeenCalled()
  })

  it("reports an uncorroborated top-level FAILED as pending, not as failed", () => {
    const status = paymentSendStatusOrPending({
      status: 3,
      transaction: { payment: { statusId: 0, status: { id: 0 } } },
    })

    expect(status).toBe(PaymentSendStatus.Pending)
    expect(recordMock).toHaveBeenCalledTimes(1)
  })
})

describe("paymentSendStatusFromIbexLnurlPay", () => {
  // payToLnurl's 201 has no top-level `status` and no
  // `transaction.payment.status` object — only `transaction.payment.statusId`
  // (documented example: 0). Settlement is read from PAYMENT-LEVEL evidence
  // only; see the top-level `settleDateUtc` tests below for why.
  const settledLnurlResponse = {
    hash: "19b7ff42e048d14791180d63592099b3394fc9ea7e3243906e810362124c29fd",
    transaction: {
      id: "dfeec8bd-b4e7-46f1-aa4a-cf4e4569df02",
      accountId: "eeba6152-9432-448e-b7d2-4205e5099924",
      payment: { statusId: 0, settleDateUtc: "2022-11-15T20:30:41.960887Z" },
    },
  }

  it("reads a recognised payment-level status when the endpoint reports one", () => {
    expect(paymentSendStatusFromIbexLnurlPay(withNestedStatus(2))).toBe(
      PaymentSendStatus.Success,
    )
    expect(
      paymentSendStatusFromIbexLnurlPay({ transaction: { payment: { statusId: 3 } } }),
    ).toBe(PaymentSendStatus.Failure)
  })

  it("treats a populated payment-level settleDateUtc as settlement when statusId is 0", () => {
    expect(paymentSendStatusFromIbexLnurlPay(settledLnurlResponse)).toBe(
      PaymentSendStatus.Success,
    )
  })

  it("does not page on the happy path", () => {
    lnurlPaymentSendStatusOrPending(settledLnurlResponse)

    expect(recordMock).not.toHaveBeenCalled()
    expect(eventMock).not.toHaveBeenCalled()
  })

  it("lets a recognised status override the settle date", () => {
    expect(
      paymentSendStatusFromIbexLnurlPay({
        ...settledLnurlResponse,
        transaction: { payment: { statusId: 3, settleDateUtc: "2022-11-15T20:30:41Z" } },
      }),
    ).toBe(PaymentSendStatus.Failure)
  })

  describe("the top-level settleDateUtc is never read as settlement", () => {
    // The vendor's documented 201 example sets the top-level settleDateUtc to
    // 1668544241 — `transaction.createdAt` ("2022-11-15T20:30:41.960887Z")
    // floored to the second — while `statusId: 0`, `payment.settleDateUtc:
    // null`, `paidMsat: 0` and `payment.hash: null` all say NOTHING SETTLED.
    // payToLnurl also registers an async settlement webhook, so the 201 is an
    // acceptance. Reading that field reported every LNURL send as success
    // regardless of outcome — the "conversion successful while no funds moved"
    // bug this module exists to close — with the Warn record suppressed on
    // that path by design.
    it("reports the vendor's documented 201 example as unconfirmed, never as success", () => {
      const status = paymentSendStatusFromIbexLnurlPay(payToLnurlMock.response)

      expect(status).toBeInstanceOf(UnconfirmedIbexPayment)
      expect(status).not.toBe(PaymentSendStatus.Success)
    })

    it("reports the documented example as pending on the resolver path", () => {
      expect(lnurlPaymentSendStatusOrPending(payToLnurlMock.response)).toBe(
        PaymentSendStatus.Pending,
      )

      // Recorded, but QUIETLY: this shape is the vendor's own documented
      // acceptance, i.e. plausibly this rail's every-send happy path. A
      // recorded exception would set the span status to ERROR (tracing.ts
      // does it unconditionally, regardless of ErrorLevel) and turn 100% of
      // the LNURL rail red.
      const recorded = soleRecord()
      expect(recorded.loud).toBe(false)
      expect(recorded.level).toBe(ErrorLevel.Warn)
      expect(recordMock).not.toHaveBeenCalled()
    })

    it("ignores a top-level settle date in every serialisation", () => {
      for (const settleDateUtc of [
        1668544241,
        "1668544241",
        "2022-11-15T20:30:41.960887Z",
        Date.now(),
      ]) {
        expect(
          paymentSendStatusFromIbexLnurlPay({
            settleDateUtc,
            transaction: { payment: { statusId: 0 } },
          }),
        ).toBeInstanceOf(UnconfirmedIbexPayment)
      }
    })

    it("does not let a top-level settle date mask an absent payment-level one", () => {
      // The exact vendor-example shape: creation-time echo at the top, null
      // below it.
      expect(
        paymentSendStatusFromIbexLnurlPay({
          settleDateUtc: 1668544241,
          transaction: { payment: { statusId: 0, settleDateUtc: null } },
        }),
      ).toBeInstanceOf(UnconfirmedIbexPayment)
    })
  })

  it("treats an unset (0) payment-level settle date as no settlement", () => {
    expect(
      paymentSendStatusFromIbexLnurlPay({
        transaction: { payment: { statusId: 0, settleDateUtc: 0 } },
      }),
    ).toBeInstanceOf(UnconfirmedIbexPayment)
  })

  describe("payment-level settleDateUtc serialisation", () => {
    // The payment-level field has no declared type at all, and every
    // payment-level date this vendor DOES declare is an ISO string
    // ("2023-07-06T14:51:59.389565Z" — see test/flash/mocks/ibex/pay-invoice.ts),
    // while the sibling top-level field declares an integer epoch. Since it is
    // the only settle-date this reader trusts, both serialisations have to be
    // read or the rule is dead for one of them.
    const atPaymentLevel = (settleDateUtc: unknown) => ({
      transaction: { payment: { statusId: 0, settleDateUtc } },
    })

    it("accepts an ISO string settle date", () => {
      expect(
        paymentSendStatusFromIbexLnurlPay(atPaymentLevel("2023-07-06T14:51:59.389565Z")),
      ).toBe(PaymentSendStatus.Success)
    })

    it("accepts an integer epoch settle date", () => {
      expect(paymentSendStatusFromIbexLnurlPay(atPaymentLevel(1668544241))).toBe(
        PaymentSendStatus.Success,
      )
    })

    it("reads an all-digit string as an epoch, not as a date", () => {
      // Date.parse("0") is 946713600000 (V8 reads a bare "0" as the year 2000),
      // so routing a stringified epoch through Date.parse inverts the check in
      // BOTH directions: the unset sentinel would read as settled, and a real
      // epoch would be rejected as an out-of-range year.
      for (const settleDateUtc of ["0", "00", "-1", "+0"]) {
        expect(
          paymentSendStatusFromIbexLnurlPay(atPaymentLevel(settleDateUtc)),
        ).toBeInstanceOf(UnconfirmedIbexPayment)
      }

      expect(paymentSendStatusFromIbexLnurlPay(atPaymentLevel("1668544241"))).toBe(
        PaymentSendStatus.Success,
      )
    })

    it("rejects the vendor's zero-date sentinel and unparseable strings", () => {
      // "0001-01-01T00:00:00Z" is this vendor's zero value (it is the
      // creationDateUtc example on the payToLnurl 201 itself) and parses to a
      // large NEGATIVE epoch — it must be rejected exactly like the integer 0.
      for (const settleDateUtc of [
        "0001-01-01T00:00:00Z",
        "",
        "   ",
        "not-a-date",
        null,
      ]) {
        expect(
          paymentSendStatusFromIbexLnurlPay(atPaymentLevel(settleDateUtc)),
        ).toBeInstanceOf(UnconfirmedIbexPayment)
      }
    })
  })

  it("raises the unreadable LNURL case at Warn, not Critical", () => {
    // No real payToLnurl response has been captured on TEST yet, so an
    // unreadable one must not page — it may be this endpoint's happy path.
    const unconfirmed = paymentSendStatusFromIbexLnurlPay({}) as UnconfirmedIbexPayment

    expect(unconfirmed).toBeInstanceOf(UnconfirmedIbexPayment)
    expect(unconfirmed.level).toBe(ErrorLevel.Warn)
  })
})

describe("lnurlPaymentSendStatusOrPending", () => {
  it("reports an unreadable response as pending and records it at the error's own level", () => {
    const status = lnurlPaymentSendStatusOrPending({ transaction: { payment: {} } })

    expect(status).toBe(PaymentSendStatus.Pending)
    const recorded = soleRecord()
    expect(recorded.level).toBe(ErrorLevel.Warn)
  })

  it("never records an exception on this rail — the dialect cannot produce one", () => {
    // The payToLnurl 201 has no top-level `status` field at all, so this reader
    // can never be in the "IBEX claimed a terminal outcome we refused" case
    // that earns a red span. Every unreadable payToLnurl response is therefore
    // quiet, which is the whole point: this rail's documented acceptance shape
    // IS unreadable, and it must not paint every send ERROR.
    for (const response of [
      {},
      null,
      undefined,
      { transaction: {} },
      { transaction: { payment: {} } },
      { transaction: { payment: { statusId: 0 } } },
      { transaction: { payment: { statusId: 0, settleDateUtc: 0 } } },
      payToLnurlMock.response,
    ]) {
      jest.clearAllMocks()

      expect(lnurlPaymentSendStatusOrPending(response)).toBe(PaymentSendStatus.Pending)

      expect(recordMock).not.toHaveBeenCalled()
      expect(soleRecord().loud).toBe(false)
    }
  })

  it("records the payment hash from the top level, where payToLnurl puts it", () => {
    // payToLnurl's 201 declares `transaction.payment.hash` with an EMPTY schema
    // and carries the 64-char hash at the top level instead. Reading only the
    // payInvoiceV2 position hands an operator transaction id and account id but
    // not the one field that names the payment — with the hash sitting right
    // there in the response.
    lnurlPaymentSendStatusOrPending({
      hash: "19b7ff42e048d14791180d63592099b3394fc9ea7e3243906e810362124c29fd",
      transaction: {
        id: "dfeec8bd-b4e7-46f1-aa4a-cf4e4569df02",
        accountId: "eeba6152-9432-448e-b7d2-4205e5099924",
        payment: { statusId: 0 },
      },
    })

    expect(soleRecord().attributes).toMatchObject({
      "ibex.transaction.id": "dfeec8bd-b4e7-46f1-aa4a-cf4e4569df02",
      "ibex.payment.hash":
        "19b7ff42e048d14791180d63592099b3394fc9ea7e3243906e810362124c29fd",
      "ibex.account.id": "eeba6152-9432-448e-b7d2-4205e5099924",
    })
  })

  it("prefers the payment-level hash when the endpoint populates it", () => {
    lnurlPaymentSendStatusOrPending({
      hash: "top-level-hash",
      transaction: { payment: { hash: "payment-level-hash", statusId: 0 } },
    })

    expect(soleRecord().attributes["ibex.payment.hash"]).toBe("payment-level-hash")
  })
})
