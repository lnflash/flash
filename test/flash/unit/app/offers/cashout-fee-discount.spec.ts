/**
 * CashoutManager.createOffer × the Fee Discount whitelist: the operator can
 * discount a named user's Flash service fee on Jamaican bank cashouts. The
 * Money math runs for real; only the ERPNext-backed whitelist read (and the
 * usual IO around offer creation) is mocked.
 */
const mockStorageAdd = jest.fn()
const mockFindWalletById = jest.fn()
const mockFindAccountById = jest.fn()
const mockValidOfferFrom = jest.fn()
const mockResolveSelection = jest.fn()
const mockAddInvoice = jest.fn()
const mockGetBankOwner = jest.fn()
const mockGetBankAccounts = jest.fn()
const mockGetFlashFeeDiscountPercent = jest.fn()

jest.mock("@services/alerts/ops-events", () => ({
  notifyOpsEvent: jest.fn(),
  toDisplayAmount: jest.requireActual("@services/alerts/ops-events").toDisplayAmount,
}))

jest.mock("@config", () => ({
  Cashout: {
    // 100 bips = 1% Flash service fee.
    OfferConfig: { fee: 100n as BasisPoints, duration: 3600 as Seconds },
    SkipPayment: false,
  },
  ExchangeRates: {},
}))

jest.mock("@app/cash-wallet-cutover/cashout-routing", () => ({
  resolveCashoutWalletSelection: (...args: unknown[]) => mockResolveSelection(...args),
}))

jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: { addInvoice: (...args: unknown[]) => mockAddInvoice(...args) },
}))

jest.mock("@services/ledger/caching", () => ({
  getBankOwnerIbexAccount: () => mockGetBankOwner(),
}))

jest.mock("@services/email", () => ({
  EmailService: { sendCashoutInitiatedEmail: jest.fn() },
}))

jest.mock("@services/frappe/ErpNext", () => ({
  __esModule: true,
  default: {
    getBankAccountsByCustomer: (...args: unknown[]) => mockGetBankAccounts(...args),
  },
}))

jest.mock("@services/frappe/fee-discounts", () => ({
  getFlashFeeDiscountPercent: (...args: unknown[]) =>
    mockGetFlashFeeDiscountPercent(...args),
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
    add: (...args: unknown[]) => mockStorageAdd(...args),
  },
}))

jest.mock("@app/offers/ValidOffer", () => ({
  __esModule: true,
  default: { from: (...args: unknown[]) => mockValidOfferFrom(...args) },
}))

jest.mock("@domain/bitcoin/lightning", () => {
  const actual = jest.requireActual("@domain/bitcoin/lightning")
  return {
    ...actual,
    decodeInvoice: jest.fn(() => ({
      destination: "0".repeat(66) as Pubkey,
      paymentHash:
        "8862fa7f4dcea0533952783bda143ff7fb7242a9573ac74f1ff944a601f02319" as PaymentHash,
      paymentRequest: "lnbc1test" as EncodedPaymentRequest,
      milliSatsAmount: 0 as MilliSatoshis,
      description: "",
      cltvDelta: null,
      amount: null,
      paymentAmount: null,
      routeHints: [],
      paymentSecret: null,
      features: [],
      expiresAt: new Date(Date.now() + 600_000),
      isExpired: false,
    })),
  }
})

import CashoutManager from "@app/offers/CashoutManager"
import { USDAmount } from "@domain/shared"

const offerId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" as OfferId
const walletId = "11111111-1111-4111-8111-111111111111" as WalletId
const flashWalletId = "22222222-2222-4222-8222-222222222222" as WalletId
const accountId = "64df1a2b3c4d5e6f78901234" as AccountId

// $500.00 -> a 1% (100 bips) service fee of exactly $5.00 (500¢).
const amount = USDAmount.cents("50000")
if (amount instanceof Error) throw amount

const offeredPayout = () => {
  expect(mockValidOfferFrom).toHaveBeenCalledTimes(1)
  return mockValidOfferFrom.mock.calls[0][0].payout
}

describe("CashoutManager fee discount", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetBankOwner.mockResolvedValue(flashWalletId)
    mockFindWalletById.mockResolvedValue({ id: walletId, accountId })
    mockFindAccountById.mockResolvedValue({
      id: accountId,
      erpParty: "party-1",
      username: "civilizedbarbarian",
    })
    mockResolveSelection.mockResolvedValue({
      route: "usd",
      userWalletId: walletId,
      flashWalletId,
    })
    mockAddInvoice.mockResolvedValue({ invoice: { bolt11: "lnbc1test" } })
    mockGetBankAccounts.mockResolvedValue([{ name: "bank-1", currency: "USD" }])
    mockGetFlashFeeDiscountPercent.mockResolvedValue(0)
    mockValidOfferFrom.mockResolvedValue({ details: {} })
    mockStorageAdd.mockResolvedValue({ id: offerId, details: {} })
  })

  it("consults the whitelist for the account's username in the cashout flow", async () => {
    await CashoutManager.createOffer(walletId, amount, "bank-1", accountId)

    expect(mockGetFlashFeeDiscountPercent).toHaveBeenCalledWith({
      username: "civilizedbarbarian",
      flow: "cashout",
    })
  })

  it("charges the standard fee for a 0% discount", async () => {
    await CashoutManager.createOffer(walletId, amount, "bank-1", accountId)

    const payout = offeredPayout()
    expect(payout.serviceFee.asCents()).toBe("500")
    expect(payout.amount.asCents()).toBe("49500")
  })

  it("discounts the service fee by the whitelisted percentage", async () => {
    mockGetFlashFeeDiscountPercent.mockResolvedValue(25)

    await CashoutManager.createOffer(walletId, amount, "bank-1", accountId)

    // 1% of $500 = 500¢ full fee; 25% off -> 375¢; payout $496.25.
    const payout = offeredPayout()
    expect(payout.serviceFee.asCents()).toBe("375")
    expect(payout.amount.asCents()).toBe("49625")
  })

  it("waives the service fee entirely at a 100% discount", async () => {
    mockGetFlashFeeDiscountPercent.mockResolvedValue(100)

    await CashoutManager.createOffer(walletId, amount, "bank-1", accountId)

    const payout = offeredPayout()
    expect(payout.serviceFee.asCents()).toBe("0")
    expect(payout.amount.asCents()).toBe("50000")
  })

  it("passes an undefined username through (accounts without one just get no discount)", async () => {
    mockFindAccountById.mockResolvedValue({ id: accountId, erpParty: "party-1" })

    await CashoutManager.createOffer(walletId, amount, "bank-1", accountId)

    expect(mockGetFlashFeeDiscountPercent).toHaveBeenCalledWith({
      username: undefined,
      flow: "cashout",
    })
    expect(offeredPayout().serviceFee.asCents()).toBe("500")
  })
})
