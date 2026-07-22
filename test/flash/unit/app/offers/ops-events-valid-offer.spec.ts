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
import { IbexError } from "@services/ibex/errors"
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
    mockPayInvoice.mockResolvedValue({ status: 2 })
    mockSubmitCashout.mockResolvedValue(true)
  })

  it("does not notify when every step succeeds", async () => {
    const offer = await makeOffer()

    const result = await offer.execute()

    expect(result).toBeInstanceOf(InitiatedCashout)
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

  it("reports the submitCashout step when submit fails after the retry", async () => {
    const submitError = new CashoutSubmitError("erp submit down")
    mockSubmitCashout.mockResolvedValue(submitError)
    const offer = await makeOffer()

    const result = await offer.execute()

    // submit failure is not surfaced to the caller — manual intervention path
    expect(result).toBeInstanceOf(InitiatedCashout)
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
    expect(notifyOpsEvent).not.toHaveBeenCalled()
  })
})
