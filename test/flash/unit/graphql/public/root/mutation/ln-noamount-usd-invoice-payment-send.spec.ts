const mockPayInvoice = jest.fn()
const mockResolveCashWalletMutationWalletIdForAccount = jest.fn()
const mockUsdWalletAmountFromWalletId = jest.fn()
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

    it("reports an unreadable response as pending and records it at Critical", async () => {
      // Critical is the payInvoiceV2 reader's severity for this condition; the
      // LNURL reader raises the same one at Warn. This is the assertion that
      // catches the two readers being swapped.
      mockPayInvoice.mockResolvedValue({ status: 0, transaction: { payment: {} } })

      const result = await resolveMutation()

      expect(result).toEqual({ errors: [], status: "pending" })
      expect(mockRecordExceptionInCurrentSpan).toHaveBeenCalledTimes(1)
      const [{ error, level }] = mockRecordExceptionInCurrentSpan.mock.calls[0]
      expect(error).toBeInstanceOf(UnconfirmedIbexPayment)
      expect(level).toBe(ErrorLevel.Critical)
    })

    it("never reports success from a top-level status alone", async () => {
      mockPayInvoice.mockResolvedValue({ status: 2, transaction: { payment: {} } })

      const result = await resolveMutation()

      expect(result).toEqual({ errors: [], status: "pending" })
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
