jest.mock("@services/tracing", () => ({
  recordExceptionInCurrentSpan: jest.fn(),
}))

import { PaymentSendStatus } from "@domain/bitcoin/lightning"
import { ErrorLevel } from "@domain/shared"
import { UnconfirmedIbexPayment } from "@services/ibex/errors"
import {
  lnurlPaymentSendStatusOrPending,
  paymentSendStatusFromIbex,
  paymentSendStatusFromIbexLnurlPay,
  paymentSendStatusOrPending,
} from "@services/ibex/payment-status"
import { recordExceptionInCurrentSpan } from "@services/tracing"

const recordMock = recordExceptionInCurrentSpan as jest.Mock

const withNestedStatus = (id: number) => ({
  transaction: { payment: { status: { id } } },
})

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

  it("raises the unreadable payInvoiceV2 case at Critical", () => {
    const unconfirmed = paymentSendStatusFromIbex({}) as UnconfirmedIbexPayment

    expect(unconfirmed.level).toBe(ErrorLevel.Critical)
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

  it("records the anomaly exactly once, as a Critical UnconfirmedIbexPayment", () => {
    for (const response of unreadableResponses) {
      recordMock.mockClear()

      paymentSendStatusOrPending(response)

      expect(recordMock).toHaveBeenCalledTimes(1)
      const [{ error, level }] = recordMock.mock.calls[0]
      expect(error).toBeInstanceOf(UnconfirmedIbexPayment)
      expect(level).toBe(ErrorLevel.Critical)
    }
  })

  it("records the identifying fields so the payment is nameable from the alert", () => {
    // Without these an operator woken by "money may or may not have moved" has
    // to trace-hop to the child ibex-client span before they can name it.
    paymentSendStatusOrPending({
      status: 0,
      transaction: {
        id: "dfeec8bd-b4e7-46f1-aa4a-cf4e4569df02",
        accountId: "eeba6152-9432-448e-b7d2-4205e5099924",
        payment: { hash: "19b7ff42e048d147", statusId: 0 },
      },
    })

    expect(recordMock).toHaveBeenCalledTimes(1)
    expect(recordMock.mock.calls[0][0].attributes).toEqual({
      "ibex.transaction.id": "dfeec8bd-b4e7-46f1-aa4a-cf4e4569df02",
      "ibex.payment.hash": "19b7ff42e048d147",
      "ibex.account.id": "eeba6152-9432-448e-b7d2-4205e5099924",
    })
  })

  it("does not record anything for a recognised status", () => {
    paymentSendStatusOrPending(withNestedStatus(1))
    paymentSendStatusOrPending(withNestedStatus(2))
    paymentSendStatusOrPending(withNestedStatus(3))
    paymentSendStatusOrPending({ status: 1 })
    paymentSendStatusOrPending({ status: 3, failureReason: 2 })

    expect(recordMock).not.toHaveBeenCalled()
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
  // (documented example: 0) next to a populated top-level `settleDateUtc`.
  const settledLnurlResponse = {
    settleDateUtc: 1668544241,
    hash: "19b7ff42e048d14791180d63592099b3394fc9ea7e3243906e810362124c29fd",
    transaction: {
      id: "dfeec8bd-b4e7-46f1-aa4a-cf4e4569df02",
      accountId: "eeba6152-9432-448e-b7d2-4205e5099924",
      payment: { statusId: 0 },
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

  it("treats a populated settleDateUtc as settlement when statusId is 0", () => {
    expect(paymentSendStatusFromIbexLnurlPay(settledLnurlResponse)).toBe(
      PaymentSendStatus.Success,
    )
  })

  it("does not page on the happy path", () => {
    lnurlPaymentSendStatusOrPending(settledLnurlResponse)

    expect(recordMock).not.toHaveBeenCalled()
  })

  it("lets a recognised status override the settle date", () => {
    expect(
      paymentSendStatusFromIbexLnurlPay({
        ...settledLnurlResponse,
        transaction: { payment: { statusId: 3 } },
      }),
    ).toBe(PaymentSendStatus.Failure)
  })

  it("treats an unset (0) settle date as no settlement", () => {
    expect(
      paymentSendStatusFromIbexLnurlPay({
        settleDateUtc: 0,
        transaction: { payment: { statusId: 0 } },
      }),
    ).toBeInstanceOf(UnconfirmedIbexPayment)
  })

  describe("settleDateUtc serialisation", () => {
    // The top-level field declares an integer epoch, but the payment-level one
    // has no declared type at all and every payment-level date this vendor DOES
    // declare is an ISO string ("2023-07-06T14:51:59.389565Z" — see
    // test/flash/mocks/ibex/pay-invoice.ts). Settlement-on-settle-date is the
    // only route by which an LNURL send can report success, so a number-only
    // reader would return the pre-fix always-pending behaviour plus a Warn span
    // on every send.
    it("accepts an ISO string settle date at the top level", () => {
      expect(
        paymentSendStatusFromIbexLnurlPay({
          settleDateUtc: "2022-11-15T20:30:41.960887Z",
          transaction: { payment: { statusId: 0 } },
        }),
      ).toBe(PaymentSendStatus.Success)
    })

    it("accepts an ISO string settle date at the payment level", () => {
      expect(
        paymentSendStatusFromIbexLnurlPay({
          transaction: {
            payment: { statusId: 0, settleDateUtc: "2023-07-06T14:51:59.389565Z" },
          },
        }),
      ).toBe(PaymentSendStatus.Success)
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
          paymentSendStatusFromIbexLnurlPay({
            settleDateUtc,
            transaction: { payment: { statusId: 0 } },
          }),
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
    expect(recordMock).toHaveBeenCalledTimes(1)
    const [{ error, level }] = recordMock.mock.calls[0]
    expect(error).toBeInstanceOf(UnconfirmedIbexPayment)
    expect(level).toBe(ErrorLevel.Warn)
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

    expect(recordMock).toHaveBeenCalledTimes(1)
    expect(recordMock.mock.calls[0][0].attributes).toEqual({
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

    expect(recordMock.mock.calls[0][0].attributes["ibex.payment.hash"]).toBe(
      "payment-level-hash",
    )
  })
})
