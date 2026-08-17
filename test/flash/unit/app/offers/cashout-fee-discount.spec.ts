/**
 * CashoutManager.createOffer × the Fee Discount whitelist: the operator can
 * discount a named user's Flash service fee on Jamaican bank cashouts. The
 * Money math runs for real — including the JMD conversion, which is the
 * primary Jamaican rail — so only the ERPNext-backed whitelist read, the
 * exchange rate, and the usual IO around offer creation are mocked.
 */
const mockStorageAdd = jest.fn()
const mockFindWalletById = jest.fn()
const mockFindAccountById = jest.fn()
const mockValidOfferFrom = jest.fn()
const mockResolveSelection = jest.fn()
const mockAddInvoice = jest.fn()
const mockGetBankOwner = jest.fn()
const mockGetBankAccounts = jest.fn()
const mockGetCashoutExchangeRate = jest.fn()
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
    getCashoutExchangeRate: (...args: unknown[]) => mockGetCashoutExchangeRate(...args),
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
import { JMDAmount, USDAmount } from "@domain/shared"
import { ExchangeRateQueryError } from "@services/frappe/errors"

const offerId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" as OfferId
const walletId = "11111111-1111-4111-8111-111111111111" as WalletId
const flashWalletId = "22222222-2222-4222-8222-222222222222" as WalletId
const accountId = "64df1a2b3c4d5e6f78901234" as AccountId

// $500.00 -> a 1% (100 bips) service fee of exactly $5.00 (500¢).
const amount = USDAmount.cents("50000")
if (amount instanceof Error) throw amount

// NCB buy rate as ERPNext serves it: J$160.00 per US$1 (16000 JMD cents).
// Chosen to divide evenly so the JMD expectations below are exact, not rounded.
const jmdRate = JMDAmount.dollars(160)
if (jmdRate instanceof Error) throw jmdRate

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
    mockGetCashoutExchangeRate.mockResolvedValue(jmdRate)
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

  describe("JMD payout (the primary Jamaican cashout rail)", () => {
    beforeEach(() => {
      mockGetBankAccounts.mockResolvedValue([{ name: "bank-1", currency: "JMD" }])
    })

    it("charges the standard fee and converts at the locked rate with no discount", async () => {
      await CashoutManager.createOffer(walletId, amount, "bank-1", accountId)

      const payout = offeredPayout()
      expect(payout.serviceFee.asCents()).toBe("500")
      // $495.00 x J$160.00 = J$79,200.00
      expect(payout.amount.asCents()).toBe("7920000")
      expect(payout.exchangeRate).toBe(jmdRate)
    })

    it("discounts the service fee and converts the LARGER usd payout to JMD", async () => {
      mockGetFlashFeeDiscountPercent.mockResolvedValue(25)

      await CashoutManager.createOffer(walletId, amount, "bank-1", accountId)

      // 1% of $500 = 500¢ full fee; 25% off -> 375¢; usd payout $496.25.
      // $496.25 x J$160.00 = J$79,400.00 — the discount must reach the JMD
      // conversion, not just the fee line.
      const payout = offeredPayout()
      expect(payout.serviceFee.asCents()).toBe("375")
      expect(payout.amount.asCents()).toBe("7940000")
      expect(payout.exchangeRate).toBe(jmdRate)
    })

    it("waives the service fee entirely at a 100% discount", async () => {
      mockGetFlashFeeDiscountPercent.mockResolvedValue(100)

      await CashoutManager.createOffer(walletId, amount, "bank-1", accountId)

      const payout = offeredPayout()
      expect(payout.serviceFee.asCents()).toBe("0")
      // $500.00 x J$160.00 = J$80,000.00
      expect(payout.amount.asCents()).toBe("8000000")
    })

    it("fails closed on a missing exchange rate — a discount never rescues a JMD offer", async () => {
      mockGetFlashFeeDiscountPercent.mockResolvedValue(25)
      mockGetCashoutExchangeRate.mockResolvedValue(
        new ExchangeRateQueryError("No USD->JMD for_buying rate found in ERPNext"),
      )

      const result = await CashoutManager.createOffer(
        walletId,
        amount,
        "bank-1",
        accountId,
      )

      expect(result).toBeInstanceOf(ExchangeRateQueryError)
      expect(mockValidOfferFrom).not.toHaveBeenCalled()
    })
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
