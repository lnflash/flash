const mockPayInvoice = jest.fn()
const mockResolveCashWalletMutationWalletIdForAccount = jest.fn()
const mockUsdWalletAmountFromWalletId = jest.fn()
const mockRecordExceptionInCurrentSpan = jest.fn()
const mockAddEventToCurrentSpan = jest.fn()

jest.mock("@services/tracing", () => ({
  addAttributesToCurrentSpan: jest.fn(),
  addEventToCurrentSpan: (...args: unknown[]) => mockAddEventToCurrentSpan(...args),
  recordExceptionInCurrentSpan: (...args: unknown[]) =>
    mockRecordExceptionInCurrentSpan(...args),
}))

jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: { payInvoice: (...args: unknown[]) => mockPayInvoice(...args) },
}))

jest.mock("@app/cash-wallet-cutover", () => ({
  resolveCashWalletMutationWalletIdForAccount: (
    ...args: Parameters<typeof mockResolveCashWalletMutationWalletIdForAccount>
  ) => mockResolveCashWalletMutationWalletIdForAccount(...args),
}))

jest.mock("@app/wallets", () => ({
  usdWalletAmountFromWalletId: (
    ...args: Parameters<typeof mockUsdWalletAmountFromWalletId>
  ) => mockUsdWalletAmountFromWalletId(...args),
}))

import { ErrorLevel, USDTAmount } from "@domain/shared"
import LnNoAmountUsdInvoicePaymentSendMutation from "@graphql/public/root/mutation/ln-noamount-usd-invoice-payment-send"
import { IbexError, UnconfirmedIbexPayment } from "@services/ibex/errors"

const walletId = "11111111-1111-4111-8111-111111111111" as WalletId
const routedWalletId = "22222222-2222-4222-8222-222222222222" as WalletId
const domainAccount = { id: "account-id" } as Account
const client = {
  cashWalletPresentation: "usdt",
  hasUsdtCashWalletSupport: true,
} as const

type MutationResult = {
  status?: string
  errors: { message: string }[]
}

const resolveMutation = (overrides: Record<string, unknown> = {}) =>
  LnNoAmountUsdInvoicePaymentSendMutation.resolve?.(
    null,
    {
      input: {
        walletId,
        paymentRequest: "lnbc1noamount",
        amount: 1234 as FractionalCentAmount,
        memo: "memo" as Memo,
        ...overrides,
      },
    },
    {
      domainAccount,
      cashWalletClientCapabilities: client,
    } as GraphQLPublicContextAuth,
    {} as never,
  ) as Promise<MutationResult>

describe("LnNoAmountUsdInvoicePaymentSendMutation", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockResolveCashWalletMutationWalletIdForAccount.mockResolvedValue(routedWalletId)
    mockUsdWalletAmountFromWalletId.mockResolvedValue(
      USDTAmount.usdCents("1234") as USDTAmount,
    )
    mockPayInvoice.mockResolvedValue({
      status: 0,
      transaction: { payment: { status: { id: 2 } } },
    })
  })

  it("pays the routed wallet with the resolved cent amount", async () => {
    const result = await resolveMutation()

    expect(mockResolveCashWalletMutationWalletIdForAccount).toHaveBeenCalledWith({
      account: domainAccount,
      walletId,
      client,
    })
    expect(mockPayInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        invoice: "lnbc1noamount",
        accountId: routedWalletId,
      }),
    )
    expect(result).toEqual({ errors: [], status: "success" })
  })

  // The two IBEX status readers are structurally interchangeable at the type
  // level — `lnurlPaymentSendStatusOrPending` accepts a payInvoiceV2 response
  // without complaint — so nothing but an assertion at the call site proves this
  // resolver is wired to the payInvoiceV2 one. Wrong-reader-on-wrong-endpoint is
  // exactly the bug class that had shipped on the LNURL rail, and the one thing
  // the reader's own exhaustive unit suite cannot see.
  describe("IBEX status reader wiring", () => {
    it("settles on a payment-level SUCCEEDED even when the top-level status is 0", async () => {
      const result = await resolveMutation()

      expect(result).toEqual({ errors: [], status: "success" })
    })

    it("reports a corroborated top-level failure — a reading only the payInvoiceV2 reader makes", async () => {
      mockPayInvoice.mockResolvedValue({
        status: 3,
        failureReason: 2,
        transaction: { payment: { statusId: 0 } },
      })

      const result = await resolveMutation()

      expect(result).toEqual({ errors: [], status: "failed" })
    })

    it("reports an unreadable response as pending and records it in the payInvoiceV2 reader's own words", async () => {
      // Both readers record at Warn (neither endpoint has a captured response
      // to justify paging), so severity alone no longer tells them apart — the
      // message does: the LNURL reader names payToLnurl and its
      // payment-level settle date. This is the assertion that catches the two
      // readers being swapped.
      //
      // The channel matters as much as the message: a response that claimed
      // NOTHING is recorded as a span event, not a recorded exception, because
      // recordExceptionInCurrentSpan sets the span status to ERROR
      // unconditionally and this shape may be a rail's ordinary answer.
      mockPayInvoice.mockResolvedValue({ status: 0, transaction: { payment: {} } })

      const result = await resolveMutation()

      expect(result).toEqual({ errors: [], status: "pending" })
      expect(mockRecordExceptionInCurrentSpan).not.toHaveBeenCalled()
      expect(mockAddEventToCurrentSpan).toHaveBeenCalledTimes(1)
      const [eventName, eventAttributes] = mockAddEventToCurrentSpan.mock.calls[0]
      expect(eventName).toBe("ibex.payment.unconfirmed")
      expect(eventAttributes["ibex.payment.unconfirmed.level"]).toBe(ErrorLevel.Warn)
      expect(eventAttributes["ibex.payment.unconfirmed.reason"]).toMatch(
        /No recognised payment status in IBEX response/,
      )
      expect(eventAttributes["ibex.payment.unconfirmed.reason"]).not.toMatch(/payToLnurl/)
    })

    it("never reports success from a top-level status alone", async () => {
      mockPayInvoice.mockResolvedValue({ status: 2, transaction: { payment: {} } })

      const result = await resolveMutation()

      expect(result).toEqual({ errors: [], status: "pending" })
      // An unhonoured terminal claim IS worth a red span — the payload
      // disagrees with itself and our `pending` may be wrong in a direction
      // that moved money.
      expect(mockAddEventToCurrentSpan).not.toHaveBeenCalled()
      expect(mockRecordExceptionInCurrentSpan).toHaveBeenCalledTimes(1)
      const [{ error }] = mockRecordExceptionInCurrentSpan.mock.calls[0]
      expect(error).toBeInstanceOf(UnconfirmedIbexPayment)
      expect((error as UnconfirmedIbexPayment).uncorroboratedOutcome).toBe("SUCCEEDED")
    })

    it("never reports failure from a top-level status alone", async () => {
      // A fabricated "failed" sends the user back to retry with a fresh
      // idempotency key against a send that may already have paid.
      mockPayInvoice.mockResolvedValue({ status: 3, transaction: { payment: {} } })

      const result = await resolveMutation()

      expect(result).toEqual({ errors: [], status: "pending" })
    })
  })

  it("maps IBEX pay failures into payload errors", async () => {
    mockPayInvoice.mockResolvedValue(new IbexError(new Error("ibex failed")))

    const result = await resolveMutation()

    expect(result.status).toBe("failed")
    expect(result.errors[0].message).toBeTruthy()
    expect(mockRecordExceptionInCurrentSpan).not.toHaveBeenCalled()
  })
})
