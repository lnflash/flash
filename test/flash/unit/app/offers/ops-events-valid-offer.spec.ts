const mockDraftCashout = jest.fn()
const mockSubmitCashout = jest.fn()
const mockPayInvoice = jest.fn()
const mockFindWalletById = jest.fn()
const mockFindAccountById = jest.fn()

jest.mock("@services/alerts/ops-events", () => ({
  notifyOpsEvent: jest.fn().mockResolvedValue(undefined),
}))

jest.mock("@config", () => ({
  Cashout: { SkipPayment: false },
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock("@services/tracing", () => ({
  addAttributesToCurrentSpan: jest.fn(),
  addEventToCurrentSpan: jest.fn(),
  recordExceptionInCurrentSpan: jest.fn(),
}))

jest.mock("@services/mongoose", () => ({
  AccountsRepository: jest.fn(() => ({
    findById: (...args: unknown[]) => mockFindAccountById(...args),
  })),
  WalletsRepository: jest.fn(() => ({
    findById: (...args: unknown[]) => mockFindWalletById(...args),
  })),
}))

jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: { payInvoice: (...args: unknown[]) => mockPayInvoice(...args) },
}))

jest.mock("@services/frappe/ErpNext", () => ({
  __esModule: true,
  default: {
    draftCashout: (...args: unknown[]) => mockDraftCashout(...args),
    submitCashout: (...args: unknown[]) => mockSubmitCashout(...args),
  },
}))

jest.mock("@app/offers/Validator", () => ({
  CashoutValidator: jest.fn(async (inputs) => inputs),
}))

import ValidOffer, { InitiatedCashout } from "@app/offers/ValidOffer"
import { CashoutDraftError, CashoutSubmitError } from "@services/frappe/errors"
import { FailedIbexPayment, IbexError } from "@services/ibex/errors"
import { USDAmount } from "@domain/shared"
import { notifyOpsEvent } from "@services/alerts/ops-events"

const walletId = "11111111-1111-4111-8111-111111111111" as WalletId
const accountId = "64df1a2b3c4d5e6f78901234" as AccountId
const cashoutId = "ACC-CSH-2026-00001"

const makeDetails = () => {
  const amount = USDAmount.cents("50000")
  if (amount instanceof Error) throw amount
  return {
    payment: {
      userAcct: walletId,
      flashAcct: "22222222-2222-4222-8222-222222222222" as WalletId,
      invoice: { paymentRequest: "lnbc1..." },
      amount,
    },
    payout: {
      bankAccountId: "bank-1",
      amount,
      serviceFee: amount,
    },
  } as unknown as Parameters<typeof ValidOffer.from>[0]
}

const makeOffer = async (): Promise<ValidOffer> => {
  const offer = await ValidOffer.from(makeDetails())
  if (offer instanceof Error) throw offer
  return offer
}

describe("ops events — ValidOffer.execute step failures", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFindWalletById.mockResolvedValue({ id: walletId, accountId })
    mockFindAccountById.mockResolvedValue({ id: accountId })
    mockDraftCashout.mockResolvedValue(cashoutId)
    // A payment-level SUCCEEDED — what a settled payInvoiceV2 200 looks like.
    // (A lone top-level `{ status: 2 }` is deliberately NOT settlement; see
    // @services/ibex/payment-status.)
    mockPayInvoice.mockResolvedValue({
      transaction: { payment: { status: { id: 2 } } },
    })
    mockSubmitCashout.mockResolvedValue(true)
  })

  it("does not notify when every step succeeds", async () => {
    const offer = await makeOffer()

    const result = await offer.execute()

    expect(result).toBeInstanceOf(InitiatedCashout)
    expect((result as InitiatedCashout).erpSubmitted).toBe(true)
    expect(notifyOpsEvent).not.toHaveBeenCalled()
  })

  it("reports the draftCashout step on ERPNext draft failure", async () => {
    const draftError = new CashoutDraftError("erp down")
    mockDraftCashout.mockResolvedValue(draftError)
    const offer = await makeOffer()

    const result = await offer.execute()

    expect(result).toBe(draftError)
    expect(notifyOpsEvent).toHaveBeenCalledTimes(1)
    expect(notifyOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        flow: "cashout",
        phase: "failed",
        status: "failed",
        accountId,
        step: "draftCashout",
        error: "CashoutDraftError",
      }),
    )
  })

  it("reports the payInvoice step on Ibex payment failure", async () => {
    const ibexError = new IbexError(new Error("no route"))
    mockPayInvoice.mockResolvedValue(ibexError)
    const offer = await makeOffer()

    const result = await offer.execute()

    expect(result).toBe(ibexError)
    expect(notifyOpsEvent).toHaveBeenCalledTimes(1)
    expect(notifyOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        step: "payInvoice",
        error: "IbexError",
        status: "failed",
      }),
    )
  })

  // The headline defect of lnflash/flash#483, on the one rail it had not
  // reached: this path only ever checked `resp instanceof IbexError`, so a 200
  // carrying a FAILED payment read as paid and Flash submitted a cashout in
  // ERPNext — on the fiat-payout rail — with no lightning payment behind it.
  // Unlike cash-wallet-cutover's send path there is no
  // balanceVerifier.verifyBalanceMove backstop here, so the status field is the
  // only check there is.
  describe("IBEX reports the payment as FAILED in a 200 body", () => {
    const failedResponses = [
      { transaction: { payment: { status: { id: 3 } } } },
      { transaction: { payment: { statusId: 3 } } },
      { status: 3, failureReason: "NO_ROUTE", transaction: { payment: { statusId: 0 } } },
    ]

    it("never submits the cashout", async () => {
      for (const resp of failedResponses) {
        jest.clearAllMocks()
        mockPayInvoice.mockResolvedValue(resp)
        const offer = await makeOffer()

        const result = await offer.execute()

        expect(result).toBeInstanceOf(FailedIbexPayment)
        expect(mockSubmitCashout).not.toHaveBeenCalled()
      }
    })

    it("reports the payInvoice step to ops", async () => {
      mockPayInvoice.mockResolvedValue(failedResponses[0])
      const offer = await makeOffer()

      await offer.execute()

      expect(notifyOpsEvent).toHaveBeenCalledTimes(1)
      expect(notifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          step: "payInvoice",
          error: "FailedIbexPayment",
          status: "failed",
        }),
      )
    })
  })

  describe("IBEX has not reported an outcome yet", () => {
    // Pending — including the unreadable-response case, which
    // paymentSendStatusOrPending reports as pending so a same-key retry cannot
    // pay twice — is submitted deliberately. The cashout is an async, reconciled
    // flow (InitiatedCashout.status is Pending by construction); holding the
    // ERPNext submit on a payment that probably did settle would strand the
    // user's funds in a draft nobody is watching. Only a definitive FAILED
    // stops the submit.
    it("still submits the cashout on an in-flight payment", async () => {
      mockPayInvoice.mockResolvedValue({ transaction: { payment: { statusId: 1 } } })
      const offer = await makeOffer()

      const result = await offer.execute()

      expect(result).toBeInstanceOf(InitiatedCashout)
      expect(mockSubmitCashout).toHaveBeenCalledTimes(1)
    })

    it("still submits the cashout on an unreadable response", async () => {
      mockPayInvoice.mockResolvedValue({ transaction: { payment: {} } })
      const offer = await makeOffer()

      const result = await offer.execute()

      expect(result).toBeInstanceOf(InitiatedCashout)
      expect(mockSubmitCashout).toHaveBeenCalledTimes(1)
    })
  })

  it("reports the submitCashout step when submit fails after the retry", async () => {
    const submitError = new CashoutSubmitError("erp submit down")
    mockSubmitCashout.mockResolvedValue(submitError)
    const offer = await makeOffer()

    const result = await offer.execute()

    // submit failure is not surfaced as an error — manual intervention path —
    // but the partial-failure fact is flagged for the caller
    expect(result).toBeInstanceOf(InitiatedCashout)
    expect((result as InitiatedCashout).erpSubmitted).toBe(false)
    expect(mockSubmitCashout).toHaveBeenCalledTimes(2)
    expect(notifyOpsEvent).toHaveBeenCalledTimes(1)
    expect(notifyOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        step: "submitCashout",
        error: "CashoutSubmitError",
        status: "failed",
      }),
    )
  })

  it("does not report submitCashout when the retry succeeds", async () => {
    mockSubmitCashout
      .mockResolvedValueOnce(new CashoutSubmitError("transient"))
      .mockResolvedValueOnce(true)
    const offer = await makeOffer()

    const result = await offer.execute()

    expect(result).toBeInstanceOf(InitiatedCashout)
    expect((result as InitiatedCashout).erpSubmitted).toBe(true)
    expect(notifyOpsEvent).not.toHaveBeenCalled()
  })
})
