import { PaymentSendStatus } from "@domain/bitcoin/lightning"
import { UnconfirmedIbexPayment } from "@services/ibex/errors"
import {
  paymentSendStatusFromIbex,
  paymentSendStatusOrPending,
} from "@services/ibex/payment-status"

const withNestedStatus = (id: number) => ({
  transaction: { payment: { status: { id } } },
})

const unreadableResponses = [
  {},
  { status: 0 },
  { status: 7 },
  { transaction: {} },
  { transaction: { payment: {} } },
  { transaction: { payment: { status: {} } } },
  { transaction: { payment: { statusId: 0, status: { id: 0 } } } },
  null,
  undefined,
]

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

  it("falls back to the top-level status field", () => {
    expect(paymentSendStatusFromIbex({ status: 3 })).toBe(PaymentSendStatus.Failure)
  })

  it("skips unset (0) fields rather than reading them as unknown", () => {
    // IBEX omits nothing: unset integers come back as 0, so a 0 in the first
    // position must not mask a real status further down the response. This is
    // what the previous `status?.id ?? statusId` chain got wrong.
    const response = {
      status: 2,
      transaction: { payment: { statusId: 0, status: { id: 0 } } },
    }

    expect(paymentSendStatusFromIbex(response)).toBe(PaymentSendStatus.Success)
  })

  it("returns UnconfirmedIbexPayment when no recognised status is present", () => {
    for (const response of unreadableResponses) {
      expect(paymentSendStatusFromIbex(response)).toBeInstanceOf(UnconfirmedIbexPayment)
    }
  })

  it("never reports success without an explicit success id", () => {
    for (const response of unreadableResponses) {
      expect(paymentSendStatusFromIbex(response)).not.toBe(PaymentSendStatus.Success)
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
})
