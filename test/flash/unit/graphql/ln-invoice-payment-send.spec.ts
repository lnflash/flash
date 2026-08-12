const mockPayInvoice = jest.fn()

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
import { IbexError, InsufficientIbexBalance } from "@services/ibex/errors"

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
