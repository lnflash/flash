// ENG-889: risk signals ride along a cash-out and never stop it.
const mockStorageGet = jest.fn()
const mockStorageConsume = jest.fn()
const mockFindWalletById = jest.fn()
const mockFindAccountById = jest.fn()
const mockDraftCashout = jest.fn()
const mockSubmitCashout = jest.fn()
const mockPayInvoice = jest.fn()
const mockListRecentBridgeDepositRows = jest.fn()
const mockGetCustomer = jest.fn()
const mockSendCashoutInitiatedEmail = jest.fn()

jest.mock("@services/alerts/ops-events", () => ({
  notifyOpsEvent: jest.fn(),
  toDisplayAmount: jest.requireActual("@services/alerts/ops-events").toDisplayAmount,
}))

jest.mock("@config", () => ({
  Cashout: { OfferConfig: {}, SkipPayment: false },
  ExchangeRates: {},
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock("@services/tracing", () => ({
  addAttributesToCurrentSpan: jest.fn(),
  addEventToCurrentSpan: jest.fn(),
  recordExceptionInCurrentSpan: jest.fn(),
}))

jest.mock("@app/cash-wallet-cutover/cashout-routing", () => ({
  resolveCashoutWalletSelection: jest.fn(),
}))

jest.mock("@services/ledger/caching", () => ({
  getBankOwnerIbexAccount: jest.fn(),
}))

jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: { payInvoice: (...args: unknown[]) => mockPayInvoice(...args) },
}))

jest.mock("@services/bridge/client", () => ({
  __esModule: true,
  default: { getCustomer: (...args: unknown[]) => mockGetCustomer(...args) },
}))

jest.mock("@services/email", () => ({
  EmailService: {
    sendCashoutInitiatedEmail: (...args: unknown[]) =>
      mockSendCashoutInitiatedEmail(...args),
  },
}))

jest.mock("@services/frappe/ErpNext", () => ({
  __esModule: true,
  default: {
    draftCashout: (...args: unknown[]) => mockDraftCashout(...args),
    submitCashout: (...args: unknown[]) => mockSubmitCashout(...args),
    listRecentBridgeDepositRows: (...args: unknown[]) =>
      mockListRecentBridgeDepositRows(...args),
  },
}))

jest.mock("@services/mongoose", () => ({
  AccountsRepository: jest.fn(() => ({
    findById: (...args: unknown[]) => mockFindAccountById(...args),
  })),
  WalletsRepository: jest.fn(() => ({
    findById: (...args: unknown[]) => mockFindWalletById(...args),
  })),
}))

jest.mock("@app/offers/storage/Redis", () => ({
  __esModule: true,
  default: {
    get: (...args: unknown[]) => mockStorageGet(...args),
    consume: (...args: unknown[]) => mockStorageConsume(...args),
  },
}))

jest.mock("@app/offers/Validator", () => ({
  CashoutValidator: jest.fn(async (inputs) => inputs),
}))

import CashoutManager from "@app/offers/CashoutManager"
import { InitiatedCashout } from "@app/offers/ValidOffer"
import {
  RISK_REMARKS_HEADER,
  RISK_SIGNALS_UNAVAILABLE_LINE,
  DEPOSIT_SIGNALS_UNAVAILABLE_LINE,
} from "@app/offers/risk-signals"
import { USDAmount } from "@domain/shared"
import { BridgeDepositHistoryQueryError } from "@services/frappe/errors"

const offerId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" as OfferId
const walletId = "11111111-1111-4111-8111-111111111111" as WalletId
const accountId = "64df1a2b3c4d5e6f78901234" as AccountId
const cashoutId = "ACC-CSH-2026-00001"

const makeOfferDetails = () => {
  const amount = USDAmount.cents("48000")
  if (amount instanceof Error) throw amount
  return {
    details: {
      payment: {
        userAcct: walletId,
        flashAcct: "22222222-2222-4222-8222-222222222222",
        invoice: { paymentRequest: "lnbc1...", paymentHash: "hash" },
        amount,
      },
      payout: { bankAccountId: "bank-1", amount, serviceFee: amount },
    },
  }
}

const frappeUtc = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ")

describe("CashoutManager.executeCashout with risk signals (ENG-889)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockStorageGet.mockResolvedValue(makeOfferDetails())
    mockStorageConsume.mockResolvedValue(true)
    mockFindWalletById.mockResolvedValue({ id: walletId, accountId })
    mockFindAccountById.mockResolvedValue({
      id: accountId,
      createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      erpParty: "Taedo Biggs",
      bridgeCustomerId: "cust-1",
    })
    mockDraftCashout.mockResolvedValue(cashoutId)
    mockPayInvoice.mockResolvedValue({
      transaction: { payment: { status: { id: 2 } } },
    })
    mockSubmitCashout.mockResolvedValue(true)
    mockGetCustomer.mockResolvedValue({
      type: "individual",
      first_name: "Taedo",
      last_name: "Biggs",
    })
  })

  it("writes the signals to the ERPNext draft and the notice", async () => {
    mockListRecentBridgeDepositRows.mockResolvedValue([
      {
        request_id: "dep-1",
        status: "Completed",
        amount: "500.0",
        currency: "usd",
        last_seen_at: frappeUtc(new Date(Date.now() - 58_000)),
        raw_payload_json: JSON.stringify({
          event_object: { source: { originator_name: "JOHN Q PUBLIC" } },
        }),
      },
    ])

    const result = await CashoutManager.executeCashout(offerId, walletId, accountId)

    expect(result).toBeInstanceOf(InitiatedCashout)
    const { remarks } = mockDraftCashout.mock.calls[0][1]
    expect(remarks.split("\n")[0]).toBe(RISK_REMARKS_HEADER)
    expect(remarks).toContain(
      'WARNING: deposit sender name does not match the account holder. Sender "JOHN Q PUBLIC", holder "Taedo Biggs".',
    )
    expect(remarks).toContain("WARNING: new account, 2 days old (under 30 days).")
    expect(remarks).toContain("Last deposit credit: under 1 min before this cash-out")

    const initiated = mockSendCashoutInitiatedEmail.mock.calls[0][0] as InitiatedCashout
    expect(initiated.riskSignals).toMatchObject({ available: true, newAccount: true })
  })

  it("pays out when the deposit lookup throws", async () => {
    mockListRecentBridgeDepositRows.mockRejectedValue(new Error("ERPNext down"))

    const result = await CashoutManager.executeCashout(offerId, walletId, accountId)

    expect(result).toBeInstanceOf(InitiatedCashout)
    expect(mockPayInvoice).toHaveBeenCalledTimes(1)
    expect(mockSubmitCashout).toHaveBeenCalledTimes(1)
    expect(mockDraftCashout.mock.calls[0][1].remarks).toContain(
      RISK_SIGNALS_UNAVAILABLE_LINE,
    )
    expect(mockSendCashoutInitiatedEmail).toHaveBeenCalledTimes(1)
  })

  it("pays out when the deposit lookup returns an error", async () => {
    mockListRecentBridgeDepositRows.mockResolvedValue(
      new BridgeDepositHistoryQueryError("ERPNext 500"),
    )

    const result = await CashoutManager.executeCashout(offerId, walletId, accountId)

    expect(result).toBeInstanceOf(InitiatedCashout)
    expect(mockPayInvoice).toHaveBeenCalledTimes(1)
    expect(mockDraftCashout.mock.calls[0][1].remarks).toContain(
      DEPOSIT_SIGNALS_UNAVAILABLE_LINE,
    )
  })
})
