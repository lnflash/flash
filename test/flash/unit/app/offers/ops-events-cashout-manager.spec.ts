const mockStorageGet = jest.fn()
const mockFindWalletById = jest.fn()
const mockValidOfferFrom = jest.fn()

jest.mock("@services/alerts/ops-events", () => ({
  notifyOpsEvent: jest.fn(),
  toDisplayAmount: jest.requireActual("@services/alerts/ops-events").toDisplayAmount,
}))

jest.mock("@config", () => ({
  Cashout: { OfferConfig: {}, SkipPayment: false },
  ExchangeRates: {},
}))

jest.mock("@app/cash-wallet-cutover/cashout-routing", () => ({
  resolveCashoutWalletSelection: jest.fn(),
}))

jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: {},
}))

jest.mock("@services/ledger/caching", () => ({
  getBankOwnerIbexAccount: jest.fn(),
}))

jest.mock("@services/email", () => ({
  EmailService: { sendCashoutInitiatedEmail: jest.fn() },
}))

jest.mock("@services/frappe/ErpNext", () => ({
  __esModule: true,
  default: {},
}))

jest.mock("@services/mongoose", () => ({
  AccountsRepository: jest.fn(() => ({})),
  WalletsRepository: jest.fn(() => ({
    findById: (...args: unknown[]) => mockFindWalletById(...args),
  })),
}))

jest.mock("@app/offers/storage/Redis", () => ({
  __esModule: true,
  default: { get: (...args: unknown[]) => mockStorageGet(...args) },
}))

jest.mock("@app/offers/ValidOffer", () => ({
  __esModule: true,
  default: { from: (...args: unknown[]) => mockValidOfferFrom(...args) },
}))

import CashoutManager from "@app/offers/CashoutManager"
import { EmailService } from "@services/email"
import { USDAmount } from "@domain/shared"
import { notifyOpsEvent } from "@services/alerts/ops-events"

const offerId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" as OfferId
const walletId = "11111111-1111-4111-8111-111111111111" as WalletId
const accountId = "64df1a2b3c4d5e6f78901234" as AccountId

const makeOffer = () => {
  const amount = USDAmount.cents("50000")
  if (amount instanceof Error) throw amount
  return {
    details: {
      payment: { userAcct: walletId, flashAcct: "flash-wallet", amount },
    },
  }
}

describe("ops events — CashoutManager.executeCashout", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockStorageGet.mockResolvedValue(makeOffer())
    mockFindWalletById.mockResolvedValue({ id: walletId, accountId })
  })

  it("notifies initiated then succeeded on a successful cashout", async () => {
    mockValidOfferFrom.mockResolvedValue({
      execute: jest.fn(async () => ({
        cashoutId: "ACC-CSH-2026-00001",
        erpSubmitted: true,
      })),
    })

    const result = await CashoutManager.executeCashout(offerId, walletId)

    expect(result).not.toBeInstanceOf(Error)
    expect(EmailService.sendCashoutInitiatedEmail).toHaveBeenCalled()
    expect(notifyOpsEvent).toHaveBeenCalledTimes(2)
    expect(notifyOpsEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        flow: "cashout",
        phase: "initiated",
        status: "pending",
        accountId,
        // display units, not cents: 50000 cents -> $500.00
        amount: { value: "500.00", currency: "USD" },
        meta: { offerId },
      }),
    )
    expect(notifyOpsEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        flow: "cashout",
        phase: "succeeded",
        status: "success",
        accountId,
        amount: { value: "500.00", currency: "USD" },
        meta: { offerId, cashoutId: "ACC-CSH-2026-00001" },
      }),
    )
  })

  it("does not notify succeeded when the ERPNext submit partially failed", async () => {
    mockValidOfferFrom.mockResolvedValue({
      execute: jest.fn(async () => ({
        cashoutId: "ACC-CSH-2026-00001",
        erpSubmitted: false,
      })),
    })

    const result = await CashoutManager.executeCashout(offerId, walletId)

    // caller-visible result is unchanged; the terminal failed event was
    // already emitted by ValidOffer.execute
    expect(result).not.toBeInstanceOf(Error)
    expect(EmailService.sendCashoutInitiatedEmail).toHaveBeenCalled()
    expect(notifyOpsEvent).toHaveBeenCalledTimes(1)
    expect(notifyOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ flow: "cashout", phase: "initiated" }),
    )
  })

  it("notifies a terminal failed event when offer validation fails", async () => {
    mockValidOfferFrom.mockResolvedValue(new Error("offer no longer valid"))

    const result = await CashoutManager.executeCashout(offerId, walletId)

    expect(result).toBeInstanceOf(Error)
    expect(notifyOpsEvent).toHaveBeenCalledTimes(2)
    expect(notifyOpsEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        flow: "cashout",
        phase: "failed",
        status: "failed",
        accountId,
        amount: { value: "500.00", currency: "USD" },
        step: "validation",
        error: "Error",
        meta: { offerId },
      }),
    )
  })

  it("notifies initiated but not succeeded when execution fails", async () => {
    mockValidOfferFrom.mockResolvedValue({
      execute: jest.fn(async () => new Error("erp down")),
    })

    const result = await CashoutManager.executeCashout(offerId, walletId)

    expect(result).toBeInstanceOf(Error)
    expect(EmailService.sendCashoutInitiatedEmail).not.toHaveBeenCalled()
    expect(notifyOpsEvent).toHaveBeenCalledTimes(1)
    expect(notifyOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ flow: "cashout", phase: "initiated", status: "pending" }),
    )
  })

  it("does not notify when the caller wallet does not own the offer", async () => {
    mockFindWalletById
      .mockResolvedValueOnce({ id: walletId, accountId: "other-account" })
      .mockResolvedValueOnce({ id: walletId, accountId })

    const result = await CashoutManager.executeCashout(offerId, walletId)

    expect(result).toBeInstanceOf(Error)
    expect(notifyOpsEvent).not.toHaveBeenCalled()
  })
})
