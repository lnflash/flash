import {
  CouldNotFindWalletFromIdError,
  IdempotencyKeyReuseError,
  InvalidIdempotencyKeyError,
} from "@domain/errors"
import {
  GiftCardIdempotencyKeyReuseError,
  GiftCardInvalidValueError,
  GiftCardLevelNotEligibleError,
  GiftCardProductNotAvailableInCountryError,
  GiftCardQuoteMismatchError,
  GiftCardsDisabledError,
  GiftCardVendorRejectedOrderError,
  GiftCardVendorUnavailableError,
} from "@domain/gift-cards"
import { ResourceAttemptsLockServiceError } from "@domain/lock"
import { GiftCardPurchaseRateLimiterExceededError } from "@domain/rate-limit/errors"
import { ValidationError } from "@domain/shared"
import {
  CompletedInvoice,
  FailedIbexPayment,
  IbexError,
  InsufficientIbexBalance,
  UnconfirmedIbexPayment,
} from "@services/ibex/errors"

const mockFindAccountById = jest.fn()
const mockFindWalletById = jest.fn()
const mockGetGiftCardProduct = jest.fn()
const mockMasterGate = jest.fn()
const mockResolveCountry = jest.fn()
const mockAuthorize = jest.fn()
const mockReleaseReservation = jest.fn()
const mockGetProvider = jest.fn()
const mockQuote = jest.fn()
const mockCreateOrder = jest.fn()
const mockGetOrder = jest.fn()
const mockPayInvoice = jest.fn()
const mockConsumeLimiter = jest.fn()
const mockDecodeInvoice = jest.fn()
const mockEncrypt = jest.fn()
const mockNotifyOpsEvent = jest.fn()
const mockSendFulfilledPush = jest.fn()
const mockAuthorizeSend = jest.fn()
const mockGateSend = jest.fn()
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }

let repo: FakeOrdersRepo
let mockConfig = makeGiftCardsConfig()
let mockSendGuardMode = "off"

jest.mock("@config", () => ({
  get GiftCardsConfig() {
    return mockConfig
  },
  getSendGuardMode: () => mockSendGuardMode,
}))
jest.mock("@services/mongoose", () => ({
  AccountsRepository: () => ({
    findById: (...a: unknown[]) => mockFindAccountById(...a),
  }),
  WalletsRepository: () => ({ findById: (...a: unknown[]) => mockFindWalletById(...a) }),
  GiftCardOrdersRepository: () => repo,
}))
jest.mock("@app/gift-cards/list-products", () => ({
  getGiftCardProduct: (...a: unknown[]) => mockGetGiftCardProduct(...a),
}))
jest.mock("@app/gift-cards/gift-cards-master-gate", () => ({
  giftCardsMasterGate: (...a: unknown[]) => mockMasterGate(...a),
  resolveAccountCountryCodeOrUnknown: (...a: unknown[]) => mockResolveCountry(...a),
}))
jest.mock("@app/gift-cards/authorize-purchase", () => ({
  authorizeGiftCardPurchase: (...a: unknown[]) => mockAuthorize(...a),
  releaseGiftCardReservation: (...a: unknown[]) => mockReleaseReservation(...a),
}))
jest.mock("@services/gift-cards/registry", () => ({
  getEnabledGiftCardProvider: (...a: unknown[]) => mockGetProvider(...a),
  getRegisteredGiftCardProviderOrError: (...a: unknown[]) => mockGetProvider(...a),
}))
jest.mock("@services/gift-cards/claim-crypto", () => ({
  encryptGiftCardClaim: (...a: unknown[]) => mockEncrypt(...a),
}))
jest.mock("@app/gift-cards/send-fulfilled-notification", () => ({
  sendGiftCardFulfilledNotificationBestEffort: (...a: unknown[]) =>
    mockSendFulfilledPush(...a),
}))
jest.mock("@app/payments/pay-invoice-via-ibex", () => ({
  payLnInvoiceViaIbex: (...a: unknown[]) => mockPayInvoice(...a),
}))
jest.mock("@app/payments/authorize-send", () => ({
  authorizeSend: (...a: unknown[]) => mockAuthorizeSend(...a),
  gateSend: (...a: unknown[]) => mockGateSend(...a),
  SendRejectionReasons: { undecodableInvoice: "undecodable-invoice" },
}))
jest.mock("@services/rate-limit", () => ({
  consumeLimiter: (...a: unknown[]) => mockConsumeLimiter(...a),
}))
jest.mock("@domain/rate-limit", () => ({
  RateLimitConfig: { giftCardPurchase: { key: "gift_card_purchase" } },
}))
jest.mock("@domain/payments", () => ({
  LnPaymentRequestNonZeroAmountRequiredError: class extends Error {},
}))
jest.mock("@domain/bitcoin/lightning", () => ({
  ...jest.requireActual("@domain/bitcoin/lightning"),
  decodeInvoice: (...a: unknown[]) => mockDecodeInvoice(...a),
}))
jest.mock("@services/alerts/ops-events", () => ({
  notifyOpsEvent: (...a: unknown[]) => mockNotifyOpsEvent(...a),
}))
jest.mock("@services/logger", () => ({
  baseLogger: {
    info: (...a: unknown[]) => mockLogger.info(...a),
    warn: (...a: unknown[]) => mockLogger.warn(...a),
    error: (...a: unknown[]) => mockLogger.error(...a),
    child: () => mockLogger,
  },
}))
jest.mock("@services/tracing", () => ({
  addAttributesToCurrentSpan: jest.fn(),
  recordExceptionInCurrentSpan: jest.fn(),
}))

import { PaymentSendStatus } from "@domain/bitcoin/lightning"
import { purchaseGiftCard } from "@app/gift-cards/purchase-gift-card"

import {
  ACCOUNT_ID,
  allMockCallText,
  makeAccount,
  makeFakeOrdersRepo,
  makeGiftCardsConfig,
  makeOrder,
  makeProduct,
  makeWallet,
  WALLET_ID,
  type FakeOrdersRepo,
} from "./fixtures"

const PAYMENT_REQUEST = "lnbc401u1p-vendor-invoice"
const PAYMENT_HASH = "a".repeat(64)
const CLAIM_CODE = "CLAIM-CODE-SECRET-9f8e7d"
const CLAIM: GiftCardClaim = {
  codes: [{ label: "Code", value: CLAIM_CODE }],
  claimLink: null,
  barcode: null,
}

// What the TBC adapter returns: no vendor-stated expiry, the BOLT11 carries it.
const VENDOR_ORDER = {
  providerOrderId: "tbc-123" as GiftCardProviderOrderId,
  paymentRequest: PAYMENT_REQUEST,
  amountSats: 40_100 as Satoshis,
  expiresAt: null,
}

const decoded = (sats: number) => ({
  paymentHash: PAYMENT_HASH,
  paymentAmount: { amount: BigInt(sats), currency: "BTC" },
  expiresAt: new Date(Date.now() + 10 * 60 * 1000),
})

const purchase = (overrides: Record<string, unknown> = {}) =>
  purchaseGiftCard({
    accountId: ACCOUNT_ID,
    walletId: WALLET_ID,
    productId: "bitcoinCompany:amazon-us",
    valueMinor: 2500,
    quantity: 1,
    idempotencyKey: "idem-1",
    ...overrides,
  })

const opsPhases = () => mockNotifyOpsEvent.mock.calls.map((c) => c[0].phase)

beforeEach(() => {
  jest.clearAllMocks()
  repo = makeFakeOrdersRepo()
  mockConfig = makeGiftCardsConfig()
  mockSendGuardMode = "off"

  mockConsumeLimiter.mockResolvedValue(true)
  mockFindAccountById.mockResolvedValue(makeAccount())
  mockFindWalletById.mockResolvedValue(makeWallet())
  mockResolveCountry.mockResolvedValue("US")
  mockMasterGate.mockReturnValue({ ok: true, providerId: "bitcoinCompany" })
  mockGetGiftCardProduct.mockResolvedValue(makeProduct())
  mockQuote.mockResolvedValue({
    productId: "bitcoinCompany:amazon-us",
    valueMinor: 2500,
    currency: "USD",
    quantity: 1,
    fiatCostMinor: 2500,
    satsCost: 40_000,
    rewardSats: 400,
    bitcoinPriceMinor: null,
    expiresAt: new Date(Date.now() + 60_000),
  })
  mockCreateOrder.mockResolvedValue(VENDOR_ORDER)
  mockGetOrder.mockResolvedValue({ kind: "fulfilled", claim: CLAIM })
  mockGetProvider.mockReturnValue({
    id: "bitcoinCompany",
    quote: mockQuote,
    createOrder: mockCreateOrder,
    getOrder: mockGetOrder,
  })
  mockAuthorize.mockResolvedValue({ authorized: true, reservationId: "res-1" })
  mockReleaseReservation.mockResolvedValue(undefined)
  mockDecodeInvoice.mockReturnValue(decoded(40_100))
  mockPayInvoice.mockResolvedValue(PaymentSendStatus.Success)
  mockEncrypt.mockReturnValue({ ciphertext: "ENCRYPTED", keyId: "k1" })
  mockSendFulfilledPush.mockResolvedValue(undefined)
})

describe("purchaseGiftCard", () => {
  it("happy path: PAID, then FULFILLED on the first poll", async () => {
    const res = await purchase()
    if (res instanceof Error) throw res

    expect(res.status).toBe("FULFILLED")
    expect(res.providerOrderId).toBe("tbc-123")
    expect(res.paymentRequest).toBe(PAYMENT_REQUEST)
    expect(res.paymentHash).toBe(PAYMENT_HASH)
    expect(res.invoiceSats).toBe(40_100)
    expect(res.paidSats).toBe(40_100)
    expect(res.claimCiphertext).toBe("ENCRYPTED")
    expect(res.statusHistory.map((h) => h.status)).toEqual([
      "CREATED",
      "INVOICE_ISSUED",
      "PAID",
      "FULFILLED",
    ])

    expect(mockCreateOrder).toHaveBeenCalledWith({
      product: makeProduct(),
      valueMinor: 2500,
      quantity: 1,
      reference: res.id,
    })

    expect(mockPayInvoice).toHaveBeenCalledTimes(1)
    const payArgs = mockPayInvoice.mock.calls[0][0]
    expect(payArgs).toMatchObject({
      paymentRequest: PAYMENT_REQUEST,
      senderWalletId: WALLET_ID,
      idempotencyKey: `giftcard:${res.id}`,
      // Bound to the order as well as the invoice: a different order can never
      // replay this one's cached success.
      requestFingerprint: `ln|${PAYMENT_REQUEST}|giftcard|${res.id}`,
    })
    expect(payArgs.senderAccount.id).toBe(ACCOUNT_ID)
    expect(typeof payArgs.authorize).toBe("function")

    expect(mockGetOrder).toHaveBeenCalledWith({
      providerOrderId: "tbc-123",
      paymentRequest: PAYMENT_REQUEST,
    })
    expect(opsPhases()).toEqual(["order-created", "order-paid", "order-fulfilled"])
    expect(mockNotifyOpsEvent.mock.calls[1][0]).toMatchObject({
      flow: "giftcard",
      status: "success",
      accountId: ACCOUNT_ID,
      amount: { value: "25.00", currency: "USD" },
      meta: {
        orderId: res.id,
        providerId: "bitcoinCompany",
        productId: "bitcoinCompany:amazon-us",
      },
    })
  })

  it("the claim never appears in ops events, logs or the stored order", async () => {
    const res = await purchase()
    if (res instanceof Error) throw res
    expect(JSON.stringify(repo.store.get(res.id))).not.toContain(CLAIM_CODE)
    expect(
      allMockCallText(
        mockNotifyOpsEvent,
        mockLogger.info,
        mockLogger.warn,
        mockLogger.error,
        mockSendFulfilledPush,
        mockPayInvoice,
      ),
    ).not.toContain(CLAIM_CODE)
  })

  it("returns PAID when the first poll says the vendor is still working", async () => {
    mockGetOrder.mockResolvedValue({ kind: "paidPendingFulfillment" })
    const res = await purchase()
    if (res instanceof Error) throw res
    expect(res.status).toBe("PAID")
    expect(opsPhases()).toEqual(["order-created", "order-paid"])
  })

  it("returns PAID when the first poll errors: the worker finishes", async () => {
    mockGetOrder.mockResolvedValue(new GiftCardVendorUnavailableError())
    const res = await purchase()
    if (res instanceof Error) throw res
    expect(res.status).toBe("PAID")
  })

  it("AlreadyPaid from the idempotent send is PAID", async () => {
    // A replayed status comes back deserialized, not as the constant.
    mockPayInvoice.mockResolvedValue({ value: "already_paid" })
    mockGetOrder.mockResolvedValue({ kind: "paidPendingFulfillment" })
    const res = await purchase()
    if (res instanceof Error) throw res
    expect(res.status).toBe("PAID")
  })

  it("releases the reservation once the order row exists", async () => {
    const res = await purchase()
    if (res instanceof Error) throw res
    expect(mockReleaseReservation).toHaveBeenCalledWith(ACCOUNT_ID, "res-1")
    // After create, not before: the hold covers the authorize→create window.
    const createOrder = repo.create.mock.invocationCallOrder[0]
    const release = mockReleaseReservation.mock.invocationCallOrder[0]
    expect(release).toBeGreaterThan(createOrder)
  })

  describe("providerPaymentRef", () => {
    const ibexResponds = (status: { value: string }) =>
      mockPayInvoice.mockImplementation(
        async (args: { onResponse?: (r: unknown) => void }) => {
          args.onResponse?.({ transaction: { id: "ibex-tx-1" } })
          return status
        },
      )

    it("records the IBEX transaction id on a PAID order", async () => {
      ibexResponds(PaymentSendStatus.Success)
      mockGetOrder.mockResolvedValue({ kind: "paidPendingFulfillment" })
      const res = await purchase()
      if (res instanceof Error) throw res
      expect(res.status).toBe("PAID")
      expect(res.providerPaymentRef).toBe("ibex-tx-1")
    })

    it("records it on a PAYMENT_PENDING order so the worker can re-query IBEX", async () => {
      ibexResponds(PaymentSendStatus.Pending)
      const res = await purchase()
      if (res instanceof Error) throw res
      expect(res.status).toBe("PAYMENT_PENDING")
      expect(res.providerPaymentRef).toBe("ibex-tx-1")
    })

    it("records it on a PAYMENT_FAILED order", async () => {
      ibexResponds(PaymentSendStatus.Failure)
      const res = await purchase()
      if (res instanceof Error) throw res
      expect(res.status).toBe("PAYMENT_FAILED")
      expect(res.providerPaymentRef).toBe("ibex-tx-1")
    })

    it("stays null when IBEX was not called (replay) or sent no id", async () => {
      mockPayInvoice.mockImplementation(
        async (args: { onResponse?: (r: unknown) => void }) => {
          args.onResponse?.({ transaction: {} })
          return PaymentSendStatus.Pending
        },
      )
      const res = await purchase()
      if (res instanceof Error) throw res
      expect(res.providerPaymentRef).toBeNull()
    })
  })

  describe("idempotency", () => {
    it("replays the existing order for the same key and parameters", async () => {
      const existing = repo.seed(makeOrder({ status: "PAID", idempotencyKey: "idem-1" }))
      const res = await purchase()
      expect(res).toBe(existing)
      expect(mockMasterGate).not.toHaveBeenCalled()
      expect(repo.create).not.toHaveBeenCalled()
      expect(mockCreateOrder).not.toHaveBeenCalled()
      expect(mockPayInvoice).not.toHaveBeenCalled()
    })

    it("refuses the same key with different parameters", async () => {
      repo.seed(makeOrder({ status: "PAID", idempotencyKey: "idem-1", valueMinor: 5000 }))
      const res = await purchase()
      expect(res).toBeInstanceOf(GiftCardIdempotencyKeyReuseError)
      expect(mockCreateOrder).not.toHaveBeenCalled()
      expect(mockPayInvoice).not.toHaveBeenCalled()
    })

    it("refuses the same key for a different product", async () => {
      repo.seed(
        makeOrder({
          status: "PAID",
          idempotencyKey: "idem-1",
          providerProductId: "netflix-us",
        }),
      )
      const res = await purchase()
      expect(res).toBeInstanceOf(GiftCardIdempotencyKeyReuseError)
    })

    it("the same key from a different wallet is a different order", async () => {
      repo.seed(
        makeOrder({
          status: "PAID",
          idempotencyKey: "idem-1",
          walletId: "other-wallet" as WalletId,
        }),
      )
      const res = await purchase()
      if (res instanceof Error) throw res
      expect(res.status).toBe("FULFILLED")
      expect(repo.create).toHaveBeenCalledTimes(1)
    })

    it("a create that loses the unique-index race replays the winner", async () => {
      repo.create.mockImplementationOnce(async () => {
        const winner = makeOrder({
          id: "order-winner" as GiftCardOrderId,
          status: "PAID",
        })
        repo.seed(winner)
        return new (jest.requireActual("@domain/errors").RepositoryError)("duplicate key")
      })
      const res = await purchase()
      if (res instanceof Error) throw res
      expect(res.id).toBe("order-winner")
      expect(mockCreateOrder).not.toHaveBeenCalled()
      expect(mockReleaseReservation).toHaveBeenCalledWith(ACCOUNT_ID, "res-1")
    })

    it("rejects a blank idempotency key", async () => {
      const res = await purchase({ idempotencyKey: "   " })
      expect(res).toBeInstanceOf(InvalidIdempotencyKeyError)
      expect(mockFindAccountById).not.toHaveBeenCalled()
    })

    describe("replay of an unpaid INVOICE_ISSUED order", () => {
      // A first attempt that died after issuing the invoice but before recording
      // the payment's outcome. The row must not be handed back as "keep polling".
      const issued = (overrides: Partial<GiftCardOrder> = {}) =>
        repo.seed(
          makeOrder({
            status: "INVOICE_ISSUED",
            idempotencyKey: "idem-1",
            providerOrderId: "tbc-123" as GiftCardProviderOrderId,
            paymentRequest: PAYMENT_REQUEST,
            paymentHash: PAYMENT_HASH,
            invoiceSats: 40_100 as Satoshis,
            expiresAt: new Date(Date.now() + 5 * 60 * 1000),
            statusHistory: [
              { status: "CREATED", at: new Date(Date.now() - 2000), reason: null },
              { status: "INVOICE_ISSUED", at: new Date(Date.now() - 1000), reason: null },
            ],
            ...overrides,
          }),
        )

      it("resumes from the pay step instead of returning the row", async () => {
        const existing = issued()
        const res = await purchase()
        if (res instanceof Error) throw res
        expect(res.id).toBe(existing.id)
        expect(res.status).toBe("FULFILLED")
        expect(res.paidSats).toBe(40_100)
        expect(res.statusHistory.map((h) => h.status)).toEqual([
          "CREATED",
          "INVOICE_ISSUED",
          "PAID",
          "FULFILLED",
        ])
        // Same key and fingerprint as the first attempt: a cached outcome is
        // replayed, an in-flight attempt is refused, a send that never happened
        // is made exactly once.
        expect(mockPayInvoice).toHaveBeenCalledTimes(1)
        expect(mockPayInvoice.mock.calls[0][0]).toMatchObject({
          paymentRequest: PAYMENT_REQUEST,
          senderWalletId: WALLET_ID,
          idempotencyKey: `giftcard:${existing.id}`,
          requestFingerprint: `ln|${PAYMENT_REQUEST}|giftcard|${existing.id}`,
        })
        // Nothing upstream of the pay step runs again.
        expect(mockMasterGate).not.toHaveBeenCalled()
        expect(mockQuote).not.toHaveBeenCalled()
        expect(mockAuthorize).not.toHaveBeenCalled()
        expect(repo.create).not.toHaveBeenCalled()
        expect(mockCreateOrder).not.toHaveBeenCalled()
      })

      it("a resumed send the first attempt already made replays as AlreadyPaid -> PAID", async () => {
        issued()
        mockPayInvoice.mockResolvedValue({ value: "already_paid" })
        mockGetOrder.mockResolvedValue({ kind: "paidPendingFulfillment" })
        const res = await purchase()
        if (res instanceof Error) throw res
        expect(res.status).toBe("PAID")
      })

      it("a resumed send with an unknown outcome -> PAYMENT_PENDING", async () => {
        issued()
        mockPayInvoice.mockResolvedValue(new IbexError(new Error("timeout")))
        const res = await purchase()
        if (res instanceof Error) throw res
        expect(res.status).toBe("PAYMENT_PENDING")
      })

      it("an INVOICE_ISSUED order past its expiry is returned as-is", async () => {
        const existing = issued({ expiresAt: new Date(Date.now() - 1) })
        const res = await purchase()
        expect(res).toBe(existing)
        expect(mockPayInvoice).not.toHaveBeenCalled()
      })

      it("does not resume while the kill switch is off: that is new money leaving", async () => {
        mockConfig = makeGiftCardsConfig({ enabled: false })
        const existing = issued()
        const res = await purchase()
        expect(res).toBe(existing)
        expect(mockPayInvoice).not.toHaveBeenCalled()
      })

      it("a CREATED order is returned as-is: vendor createOrder is not idempotent", async () => {
        const existing = repo.seed(
          makeOrder({ status: "CREATED", idempotencyKey: "idem-1" }),
        )
        const res = await purchase()
        expect(res).toBe(existing)
        expect(mockCreateOrder).not.toHaveBeenCalled()
        expect(mockPayInvoice).not.toHaveBeenCalled()
      })

      it("a PAYMENT_PENDING order is returned as-is for the worker to settle", async () => {
        const existing = repo.seed(
          makeOrder({ status: "PAYMENT_PENDING", idempotencyKey: "idem-1" }),
        )
        const res = await purchase()
        expect(res).toBe(existing)
        expect(mockPayInvoice).not.toHaveBeenCalled()
      })
    })
  })

  describe("refusals before any order exists", () => {
    // Every refusal in this block must happen before a row, a vendor order or
    // a payment exists — checked once here rather than retyped per test.
    const expectNoOrderWork = () => {
      expect(repo.create).not.toHaveBeenCalled()
      expect(mockCreateOrder).not.toHaveBeenCalled()
      expect(mockPayInvoice).not.toHaveBeenCalled()
    }
    afterEach(expectNoOrderWork)

    it("rate limited", async () => {
      mockConsumeLimiter.mockResolvedValue(new GiftCardPurchaseRateLimiterExceededError())
      const res = await purchase()
      expect(res).toBeInstanceOf(GiftCardPurchaseRateLimiterExceededError)
      expect(mockFindAccountById).not.toHaveBeenCalled()
    })

    it("a limiter store fault falls through", async () => {
      mockConsumeLimiter.mockResolvedValue(new Error("redis down"))
      mockMasterGate.mockReturnValue({ ok: false, error: new GiftCardsDisabledError() })
      const res = await purchase()
      expect(res).toBeInstanceOf(GiftCardsDisabledError)
      expect(mockLogger.warn).toHaveBeenCalled()
    })

    it("wallet not found", async () => {
      mockFindWalletById.mockResolvedValue(new CouldNotFindWalletFromIdError())
      const res = await purchase()
      expect(res).toBeInstanceOf(CouldNotFindWalletFromIdError)
    })

    it("wallet not owned by the account", async () => {
      mockFindWalletById.mockResolvedValue(makeWallet({ accountId: "someone-else" }))
      const res = await purchase()
      expect(res).toBeInstanceOf(ValidationError)
      expect(mockMasterGate).not.toHaveBeenCalled()
    })

    it("gate closed", async () => {
      mockMasterGate.mockReturnValue({ ok: false, error: new GiftCardsDisabledError() })
      const res = await purchase()
      expect(res).toBeInstanceOf(GiftCardsDisabledError)
      expect(mockMasterGate).toHaveBeenCalledWith("US")
      expect(mockGetGiftCardProduct).not.toHaveBeenCalled()
    })

    it("product from a provider not routed for the account's country", async () => {
      mockGetGiftCardProduct.mockResolvedValue(
        makeProduct({
          providerId: "bitrefill",
          id: "bitrefill:amazon-us" as GiftCardProductId,
        }),
      )
      const res = await purchase({ productId: "bitrefill:amazon-us" })
      expect(res).toBeInstanceOf(GiftCardProductNotAvailableInCountryError)
    })

    it("invalid value for the product", async () => {
      const res = await purchase({ valueMinor: 100 }) // below minValue 500
      expect(res).toBeInstanceOf(GiftCardInvalidValueError)
      expect(mockQuote).not.toHaveBeenCalled()
    })

    it("invalid quantity", async () => {
      const res = await purchase({ quantity: 11 })
      expect(res).toBeInstanceOf(GiftCardInvalidValueError)
    })

    it("limits rejection", async () => {
      mockAuthorize.mockResolvedValue({
        authorized: false,
        error: new GiftCardLevelNotEligibleError(),
        reason: "level-not-eligible",
      })
      const res = await purchase()
      expect(res).toBeInstanceOf(GiftCardLevelNotEligibleError)
      expect(mockQuote).toHaveBeenCalledTimes(1)
    })
  })

  describe("vendor order", () => {
    it("vendor rejection -> FAILED, no payment, error returned", async () => {
      mockCreateOrder.mockResolvedValue(
        new GiftCardVendorRejectedOrderError("out of stock"),
      )
      const res = await purchase()
      expect(res).toBeInstanceOf(GiftCardVendorRejectedOrderError)
      const order = [...repo.store.values()][0]
      expect(order.status).toBe("FAILED")
      expect(order.failureReason).toContain("GiftCardVendorRejectedOrderError")
      expect(mockPayInvoice).not.toHaveBeenCalled()
      expect(opsPhases()).toEqual(["order-created", "order-failed"])
    })

    it("vendor 5xx -> FAILED, the unavailable error is passed through", async () => {
      mockCreateOrder.mockResolvedValue(new GiftCardVendorUnavailableError())
      const res = await purchase()
      expect(res).toBeInstanceOf(GiftCardVendorUnavailableError)
      expect([...repo.store.values()][0].status).toBe("FAILED")
      expect(mockPayInvoice).not.toHaveBeenCalled()
    })

    it("an undecodable vendor invoice -> FAILED, no payment", async () => {
      mockDecodeInvoice.mockReturnValue(new Error("bad bolt11"))
      const res = await purchase()
      expect(res).toBeInstanceOf(GiftCardVendorRejectedOrderError)
      expect([...repo.store.values()][0].status).toBe("FAILED")
      expect(mockPayInvoice).not.toHaveBeenCalled()
    })

    it("invoice above quote tolerance -> FAILED + GiftCardQuoteMismatchError, no payment", async () => {
      // quote 40_000, tolerance 100bps -> max 40_400
      mockDecodeInvoice.mockReturnValue(decoded(40_401))
      mockCreateOrder.mockResolvedValue({ ...VENDOR_ORDER, amountSats: 40_401 })
      const res = await purchase()
      expect(res).toBeInstanceOf(GiftCardQuoteMismatchError)
      const order = [...repo.store.values()][0]
      expect(order.status).toBe("FAILED")
      expect(order.failureReason).toContain("quote-mismatch")
      expect(mockPayInvoice).not.toHaveBeenCalled()
    })

    it("invoice exactly at tolerance is paid", async () => {
      mockDecodeInvoice.mockReturnValue(decoded(40_400))
      mockCreateOrder.mockResolvedValue({ ...VENDOR_ORDER, amountSats: 40_400 })
      const res = await purchase()
      if (res instanceof Error) throw res
      expect(mockPayInvoice).toHaveBeenCalledTimes(1)
    })

    it("a vendor-stated amount above the decoded one is also checked", async () => {
      mockDecodeInvoice.mockReturnValue(decoded(40_000))
      mockCreateOrder.mockResolvedValue({ ...VENDOR_ORDER, amountSats: 45_000 })
      const res = await purchase()
      expect(res).toBeInstanceOf(GiftCardQuoteMismatchError)
    })

    it("order expiry is capped at the decoded BOLT11 expiry", async () => {
      const soon = new Date(Date.now() + 2 * 60 * 1000)
      mockDecodeInvoice.mockReturnValue({ ...decoded(40_100), expiresAt: soon })
      const res = await purchase()
      if (res instanceof Error) throw res
      expect(res.expiresAt).toEqual(soon)
    })

    it("falls back to the order TTL when the invoice carries no usable expiry", async () => {
      mockDecodeInvoice.mockReturnValue({ ...decoded(40_100), expiresAt: new Date(NaN) })
      const res = await purchase()
      if (res instanceof Error) throw res
      const created = repo.create.mock.calls[0][0] as { expiresAt: Date }
      expect(res.expiresAt).toEqual(created.expiresAt)
      expect(res.expiresAt.getTime() - Date.now()).toBeGreaterThan(14 * 60 * 1000)
    })

    it("the order TTL caps an invoice that outlives it", async () => {
      const late = new Date(Date.now() + 60 * 60 * 1000)
      mockDecodeInvoice.mockReturnValue({ ...decoded(40_100), expiresAt: late })
      const res = await purchase()
      if (res instanceof Error) throw res
      const created = repo.create.mock.calls[0][0] as { expiresAt: Date }
      expect(res.expiresAt).toEqual(created.expiresAt)
    })

    it("a vendor-stated expiry earlier than the invoice's is honoured", async () => {
      const vendorSoon = new Date(Date.now() + 60 * 1000)
      mockCreateOrder.mockResolvedValue({ ...VENDOR_ORDER, expiresAt: vendorSoon })
      const res = await purchase()
      if (res instanceof Error) throw res
      expect(res.expiresAt).toEqual(vendorSoon)
    })
  })

  describe("payment outcomes", () => {
    it("Failure -> PAYMENT_FAILED order returned, no vendor poll", async () => {
      mockPayInvoice.mockResolvedValue(PaymentSendStatus.Failure)
      const res = await purchase()
      if (res instanceof Error) throw res
      expect(res.status).toBe("PAYMENT_FAILED")
      expect(mockGetOrder).not.toHaveBeenCalled()
      expect(opsPhases()).toEqual(["order-created", "order-failed"])
      expect(mockNotifyOpsEvent.mock.calls[1][0].meta.reason).toBe("payment-failed")
    })

    describe("errors that PROVE IBEX never accepted the send -> PAYMENT_FAILED", () => {
      // Only these may tell the client "nothing left the wallet, buy again".
      it.each([
        [
          "InsufficientIbexBalance (IBEX 400)",
          () =>
            new InsufficientIbexBalance(
              new Error("400"),
              undefined,
              "insufficient balance, account: abc",
            ),
        ],
        [
          "FailedIbexPayment (corroborated FAILED on the 200)",
          () => new FailedIbexPayment("no route"),
        ],
        [
          "InvalidIdempotencyKeyError (wrapper refused)",
          () => new InvalidIdempotencyKeyError("k"),
        ],
        [
          "IdempotencyKeyReuseError (wrapper refused)",
          () => new IdempotencyKeyReuseError(),
        ],
      ])("%s", async (_label, make) => {
        const sendError = make()
        mockPayInvoice.mockResolvedValue(sendError)
        const res = await purchase()
        expect(res).toBe(sendError)
        const order = [...repo.store.values()][0]
        expect(order.status).toBe("PAYMENT_FAILED")
        expect(order.failureReason).toContain(sendError.constructor.name)
        expect(mockGetOrder).not.toHaveBeenCalled()
        expect(opsPhases()).toEqual(["order-created", "order-failed"])
      })

      it("a send-guard rejection (the guard runs before the IBEX call)", async () => {
        mockSendGuardMode = "enforce"
        const rejection = new ValidationError("over daily limit")
        mockAuthorizeSend.mockResolvedValue(rejection)
        // Mirror the wrapper: authorize immediately before execute, and a
        // rejection short-circuits without calling IBEX.
        mockPayInvoice.mockImplementation(
          async (args: { authorize: () => Promise<true | Error> }) => {
            const verdict = await args.authorize()
            return verdict instanceof Error ? verdict : PaymentSendStatus.Success
          },
        )
        const res = await purchase()
        expect(res).toBe(rejection)
        const order = [...repo.store.values()][0]
        expect(order.status).toBe("PAYMENT_FAILED")
        expect(order.failureReason).toContain("ValidationError")
      })
    })

    describe("errors that leave the outcome unknown -> PAYMENT_PENDING, never PAYMENT_FAILED", () => {
      // A socket reset / gateway 5xx / timeout after IBEX accepted the request
      // (the KNOWN GAP in @app/payments/idempotency) may have moved money. The
      // pending order is returned so the client polls instead of buying again.
      it.each([
        ["a generic IbexError", () => new IbexError(new Error("socket hang up"))],
        ["UnconfirmedIbexPayment", () => new UnconfirmedIbexPayment("unreadable 200")],
        [
          "CompletedInvoice (already prepared — possibly by our first attempt)",
          () => new CompletedInvoice(new Error("payment already prepared")),
        ],
        [
          "a busy idempotency lock (concurrent same-key attempt in flight)",
          () => new ResourceAttemptsLockServiceError(),
        ],
      ])("%s", async (_label, make) => {
        const sendError = make()
        mockPayInvoice.mockResolvedValue(sendError)
        const res = await purchase()
        if (res instanceof Error) throw res
        expect(res.status).toBe("PAYMENT_PENDING")
        expect(res.providerPaymentRef).toBeNull()
        expect(res.failureReason).toBeNull()
        expect(res.statusHistory[res.statusHistory.length - 1].reason).toBe(
          `payment-unconfirmed: ${sendError.constructor.name}`,
        )
        expect(mockGetOrder).not.toHaveBeenCalled()
        expect(opsPhases()).toEqual(["order-created", "payment-pending"])
        expect(mockNotifyOpsEvent.mock.calls[1][0]).toMatchObject({
          status: "pending",
          error: sendError.constructor.name,
          meta: expect.objectContaining({
            reason: `payment-unconfirmed: ${sendError.constructor.name}`,
          }),
        })
        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ orderId: res.id, error: sendError.constructor.name }),
          expect.stringContaining("PAYMENT_PENDING"),
        )
      })

      it("keeps the IBEX transaction id when the error came after IBEX answered", async () => {
        mockPayInvoice.mockImplementation(
          async (args: { onResponse?: (r: unknown) => void }) => {
            args.onResponse?.({ transaction: { id: "ibex-tx-1" } })
            return new IbexError(new Error("connection reset while reading body"))
          },
        )
        const res = await purchase()
        if (res instanceof Error) throw res
        expect(res.status).toBe("PAYMENT_PENDING")
        expect(res.providerPaymentRef).toBe("ibex-tx-1")
      })

      it("a concurrent attempt that already moved the order on wins", async () => {
        // The replay's send hits the busy lock while the first attempt, still
        // running, records PAID. The replay must not clobber that.
        mockPayInvoice.mockImplementation(async () => {
          const [order] = [...repo.store.values()]
          await repo.transition({
            id: order.id,
            from: ["INVOICE_ISSUED"],
            to: "PAID",
            reason: "payment-settled",
            patch: { paidSats: 40_100 as Satoshis, providerPaymentRef: "ibex-tx-1" },
          })
          return new ResourceAttemptsLockServiceError()
        })
        const res = await purchase()
        if (res instanceof Error) throw res
        expect(res.status).toBe("PAID")
        expect(res.providerPaymentRef).toBe("ibex-tx-1")
      })
    })

    it("Pending -> PAYMENT_PENDING, no vendor poll", async () => {
      mockPayInvoice.mockResolvedValue(PaymentSendStatus.Pending)
      const res = await purchase()
      if (res instanceof Error) throw res
      expect(res.status).toBe("PAYMENT_PENDING")
      expect(mockGetOrder).not.toHaveBeenCalled()
      expect(opsPhases()).toEqual(["order-created", "payment-pending"])
    })
  })

  describe("send guard hook", () => {
    it("is a no-op when the send guard is off", async () => {
      await purchase()
      const { authorize } = mockPayInvoice.mock.calls[0][0]
      await expect(authorize()).resolves.toBe(true)
      expect(mockAuthorizeSend).not.toHaveBeenCalled()
    })

    it("decodes the invoice and judges the decoded sats as a lightning send", async () => {
      mockSendGuardMode = "log-only"
      mockAuthorizeSend.mockResolvedValue(true)
      await purchase()
      const { authorize } = mockPayInvoice.mock.calls[0][0]
      await expect(authorize()).resolves.toBe(true)
      expect(mockAuthorizeSend).toHaveBeenCalledWith({
        senderAccount: expect.objectContaining({ id: ACCOUNT_ID }),
        senderWalletId: WALLET_ID,
        amount: { currency: "BTC", sats: BigInt(40_100) },
        kind: "lightning",
      })
    })

    it("routes an undecodable invoice through gateSend", async () => {
      mockSendGuardMode = "enforce"
      await purchase()
      mockDecodeInvoice.mockReturnValue(new Error("bad"))
      mockGateSend.mockResolvedValue(new ValidationError("undecodable"))
      const { authorize } = mockPayInvoice.mock.calls[0][0]
      const out = await authorize()
      expect(out).toBeInstanceOf(ValidationError)
      expect(mockGateSend).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "undecodable-invoice", kind: "lightning" }),
      )
    })
  })
})
