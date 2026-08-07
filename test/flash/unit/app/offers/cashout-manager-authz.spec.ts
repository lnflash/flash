const mockStorageGet = jest.fn()
const mockStorageAdd = jest.fn()
const mockFindWalletById = jest.fn()
const mockFindAccountById = jest.fn()
const mockValidOfferFrom = jest.fn()
const mockResolveSelection = jest.fn()
const mockAddInvoice = jest.fn()
const mockGetBankOwner = jest.fn()
const mockGetBankAccounts = jest.fn()

jest.mock("@services/alerts/ops-events", () => ({
  notifyOpsEvent: jest.fn(),
  toDisplayAmount: jest.requireActual("@services/alerts/ops-events").toDisplayAmount,
}))

jest.mock("@config", () => ({
  Cashout: {
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
import { USDAmount, ValidationError } from "@domain/shared"

const offerId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" as OfferId
const walletId = "11111111-1111-4111-8111-111111111111" as WalletId
const flashWalletId = "22222222-2222-4222-8222-222222222222" as WalletId
const callerAccountId = "64df1a2b3c4d5e6f78901234" as AccountId
const otherAccountId = "75ef2b3c4d5e6f78901234aa" as AccountId

const amount = USDAmount.cents("50000")
if (amount instanceof Error) throw amount

describe("CashoutManager authorization", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetBankOwner.mockResolvedValue(flashWalletId)
    mockFindWalletById.mockResolvedValue({ id: walletId, accountId: callerAccountId })
    mockFindAccountById.mockResolvedValue({ id: callerAccountId, erpParty: "party-1" })
    mockResolveSelection.mockResolvedValue({
      route: "usd",
      userWalletId: walletId,
      flashWalletId,
    })
    mockAddInvoice.mockResolvedValue({ invoice: { bolt11: "lnbc1test" } })
    mockGetBankAccounts.mockResolvedValue([{ name: "bank-1", currency: "USD" }])
    mockValidOfferFrom.mockResolvedValue({
      details: {},
      execute: jest.fn().mockResolvedValue({ erpSubmitted: true, cashoutId: "c-1" }),
    })
    mockStorageGet.mockResolvedValue({
      details: {
        payment: { userAcct: walletId, flashAcct: flashWalletId, amount },
        payout: { bankAccountId: "bank-1", amount, serviceFee: amount },
      },
    })
    mockStorageAdd.mockResolvedValue({ id: offerId, details: {} })
  })

  describe("createOffer", () => {
    it("rejects when the walletId belongs to a different account", async () => {
      // Given a wallet owned by someone other than the caller
      mockFindWalletById.mockResolvedValue({ id: walletId, accountId: otherAccountId })

      // When the caller requests an offer against that wallet
      const result = await CashoutManager.createOffer(
        walletId,
        amount,
        "bank-1",
        callerAccountId,
      )

      // Then it is rejected before any money-moving side effect runs
      expect(result).toBeInstanceOf(ValidationError)
      expect(mockResolveSelection).not.toHaveBeenCalled()
      expect(mockAddInvoice).not.toHaveBeenCalled()
      expect(mockStorageAdd).not.toHaveBeenCalled()
    })

    it("proceeds when the walletId belongs to the caller", async () => {
      // Given the default fixtures (wallet owned by callerAccountId)

      // When the caller requests an offer against their own wallet
      const result = await CashoutManager.createOffer(
        walletId,
        amount,
        "bank-1",
        callerAccountId,
      )

      // Then the offer is created
      expect(result).not.toBeInstanceOf(Error)
      if (result instanceof Error) throw result
      expect(result.id).toEqual(offerId)
    })
  })

  describe("executeCashout", () => {
    it("rejects when the provided walletId belongs to a different account", async () => {
      // Given a caller presenting a wallet owned by someone else
      mockFindWalletById.mockResolvedValue({ id: walletId, accountId: otherAccountId })

      // When the caller executes an offer with that wallet
      const result = await CashoutManager.executeCashout(
        offerId,
        walletId,
        callerAccountId,
      )

      // Then it is rejected before validation/execution runs
      expect(result).toBeInstanceOf(ValidationError)
      expect(mockValidOfferFrom).not.toHaveBeenCalled()
    })

    it("proceeds when the provided walletId belongs to the caller", async () => {
      // Given the default fixtures (provided + settlement wallet both caller-owned)

      // When the caller executes their offer
      const result = await CashoutManager.executeCashout(
        offerId,
        walletId,
        callerAccountId,
      )

      // Then execution proceeds
      expect(result).not.toBeInstanceOf(Error)
      expect(mockValidOfferFrom).toHaveBeenCalled()
    })
  })
})
