const mockPayInvoice = jest.fn()
const mockRecordExceptionInCurrentSpan = jest.fn()

jest.mock("@services/tracing", () => ({
  addAttributesToCurrentSpan: jest.fn(),
  recordExceptionInCurrentSpan: (...args: unknown[]) =>
    mockRecordExceptionInCurrentSpan(...args),
}))

jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: { payInvoice: (...args: unknown[]) => mockPayInvoice(...args) },
}))

// Run the resolver's execute() directly — idempotency plumbing is not under test
jest.mock("@app/payments/idempotency", () => ({
  withPaymentIdempotency: async ({ execute }: { execute: () => Promise<unknown> }) =>
    execute(),
}))

import { ErrorLevel } from "@domain/shared"
import LnInvoicePaymentSendMutation from "@graphql/public/root/mutation/ln-invoice-payment-send"
import {
  IbexError,
  InsufficientIbexBalance,
  UnconfirmedIbexPayment,
} from "@services/ibex/errors"

const insufficientDetail =
  "insufficient balance. Current Balance: 5.000000. Estimated Fee: 0.001109. invoice amount: 5.042164. account: 39c6e986-979b-40ab-9e7b-df18a9277a84"
// client-facing message strips IBEX's trailing internal account UUID
const insufficientDetailStripped =
  "insufficient balance. Current Balance: 5.000000. Estimated Fee: 0.001109. invoice amount: 5.042164"

type PaymentSendResult = {
  status?: string
  errors: { message: string; code?: string }[]
}

const resolvePayment = async (): Promise<PaymentSendResult> => {
  const resolve = LnInvoicePaymentSendMutation.resolve as unknown as (
    source: null,
    args: { input: Record<string, unknown> },
    ctx: { domainAccount: Record<string, unknown> },
  ) => Promise<PaymentSendResult>

  return resolve(
    null,
    { input: { walletId: "wallet-1", paymentRequest: "lnbc1" } },
    { domainAccount: { id: "account-1" } },
  )
}

describe("lnInvoicePaymentSend IBEX error surfacing (issue #93)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("returns a typed INSUFFICIENT_BALANCE error for insufficient-balance failures", async () => {
    mockPayInvoice.mockResolvedValue(
      new InsufficientIbexBalance(
        new Error("Bad Request"),
        ErrorLevel.Info,
        insufficientDetail,
      ),
    )

    const result = await resolvePayment()

    expect(result.status).toBe("failed")
    expect(result.errors[0]).toMatchObject({
      code: "INSUFFICIENT_BALANCE",
      message: insufficientDetailStripped,
    })
    // never the internal IBEX account UUID
    expect(result.errors[0].message).not.toContain("account:")
  })

  it("keeps the generic message for other IBEX failures", async () => {
    mockPayInvoice.mockResolvedValue(new IbexError(new Error("some other 400")))

    const result = await resolvePayment()

    expect(result.status).toBe("failed")
    expect(result.errors[0].message).toBe(
      "An unexpected error occurred. Please try again later.",
    )
    expect(result.errors[0].code).toBeUndefined()
  })

  it("returns success for a settled payment", async () => {
    mockPayInvoice.mockResolvedValue({
      transaction: { payment: { status: { id: 2 } } },
    })

    const result = await resolvePayment()

    expect(result.status).toBe("success")
    expect(result.errors).toEqual([])
  })
})

// The two IBEX status readers are structurally interchangeable at the type
// level — `lnurlPaymentSendStatusOrPending` accepts a payInvoiceV2 response
// without complaint — so nothing but an assertion at the call site proves this
// resolver is wired to the payInvoiceV2 one. Wrong-reader-on-wrong-endpoint is
// exactly the bug class that had shipped on the LNURL rail, and the one thing
// the reader's own exhaustive unit suite cannot see.
describe("lnInvoicePaymentSend IBEX status reader wiring", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("settles on a payment-level SUCCEEDED even when the top-level status is 0", async () => {
    mockPayInvoice.mockResolvedValue({
      status: 0,
      transaction: { payment: { status: { id: 2 } } },
    })

    const result = await resolvePayment()

    expect(result).toEqual({ errors: [], status: "success" })
  })

  it("reports a corroborated top-level failure — a reading only the payInvoiceV2 reader makes", async () => {
    // payToLnurl's dialect has no top-level `status` at all, so its reader
    // would report this exact response as pending.
    mockPayInvoice.mockResolvedValue({
      status: 3,
      failureReason: 2,
      transaction: { payment: { statusId: 0 } },
    })

    const result = await resolvePayment()

    expect(result).toEqual({ errors: [], status: "failed" })
  })

  it("reports an unreadable response as pending and records it at Critical", async () => {
    // Critical is the payInvoiceV2 reader's severity for this condition; the
    // LNURL reader raises the same one at Warn. This is the assertion that
    // catches the two readers being swapped.
    mockPayInvoice.mockResolvedValue({ status: 0, transaction: { payment: {} } })

    const result = await resolvePayment()

    expect(result).toEqual({ errors: [], status: "pending" })
    expect(mockRecordExceptionInCurrentSpan).toHaveBeenCalledTimes(1)
    const [{ error, level }] = mockRecordExceptionInCurrentSpan.mock.calls[0]
    expect(error).toBeInstanceOf(UnconfirmedIbexPayment)
    expect(level).toBe(ErrorLevel.Critical)
  })

  it("never reports success from a top-level status alone", async () => {
    mockPayInvoice.mockResolvedValue({ status: 2, transaction: { payment: {} } })

    const result = await resolvePayment()

    expect(result).toEqual({ errors: [], status: "pending" })
  })

  it("never reports failure from a top-level status alone", async () => {
    // A fabricated "failed" sends the user back to retry with a fresh
    // idempotency key against a send that may already have paid.
    mockPayInvoice.mockResolvedValue({ status: 3, transaction: { payment: {} } })

    const result = await resolvePayment()

    expect(result).toEqual({ errors: [], status: "pending" })
  })
})
