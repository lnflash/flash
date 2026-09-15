import {
  CouldNotFindWalletFromIdError,
  IdempotencyKeyReuseError,
  InvalidIdempotencyKeyError,
  RepositoryError,
  UnknownRepositoryError,
} from "@domain/errors"
import {
  GiftCardClaimCryptoError,
  GiftCardIdempotencyKeyReuseError,
  GiftCardOrderNotFoundError,
  GiftCardOrderStateError,
  GiftCardInvalidValueError,
  GiftCardLevelNotEligibleError,
  GiftCardProductNotAvailableInCountryError,
  GiftCardQuoteMismatchError,
  GiftCardsDisabledError,
  GiftCardVendorRejectedOrderError,
  GiftCardVendorUnavailableError,
  UnknownGiftCardError,
} from "@domain/gift-cards"
import { ResourceAttemptsLockServiceError, UnknownLockServiceError } from "@domain/lock"
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
const mockClaimCryptoReady = jest.fn()
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
  claimCryptoReady: (...a: unknown[]) => mockClaimCryptoReady(...a),
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
const opsEvent = (phase: string) =>
  mockNotifyOpsEvent.mock.calls.map((c) => c[0]).find((e) => e.phase === phase)

/** The first order the fake repo created (purchase creates exactly one). */
const storedOrder = () => [...repo.store.values()][0]

/**
 * Make the transition INTO `to` fail with `error`, once, leaving every other
 * transition real. Targets the bookkeeping step after IBEX answered without
 * disturbing CREATED → INVOICE_ISSUED before it.
 */
const failTransitionTo = (
  to: GiftCardOrderStatus,
  error: RepositoryError | GiftCardOrderStateError,
) => {
  const real = repo.transition.getMockImplementation()
  if (!real) throw new Error("fake repo has no transition implementation")
  let fired = false
  repo.transition.mockImplementation(async (args) => {
    if (!fired && args.to === to) {
      fired = true
      return error
    }
    return real(args)
  })
}

/**
 * IBEX answers `status`, but by then a concurrent same-key attempt has already
 * moved the row (the fake repo IS the shared row). `ref` is what that attempt
 * recorded; `null` means this call's own cached replay carried no response.
 */
const concurrentAttemptWrote = (
  status: { value: string },
  to: GiftCardOrderStatus,
  ref: string | null,
) =>
  mockPayInvoice.mockImplementation(async () => {
    const order = storedOrder()
    const from: GiftCardOrderStatus[] =
      to === "PAYMENT_PENDING"
        ? ["INVOICE_ISSUED"]
        : ["INVOICE_ISSUED", "PAYMENT_PENDING"]
    const moved = await repo.transition({
      id: order.id,
      from,
      to,
      reason: "concurrent-attempt",
      patch: ref ? { providerPaymentRef: ref, paidSats: 40_100 as Satoshis } : {},
    })
    if (moved instanceof Error) throw moved
    return status
  })

beforeEach(() => {
  jest.clearAllMocks()
  repo = makeFakeOrdersRepo()
  mockConfig = makeGiftCardsConfig()
  mockSendGuardMode = "off"

  mockConsumeLimiter.mockResolvedValue(true)
  mockFindAccountById.mockResolvedValue(makeAccount())
  mockFindWalletById.mockResolvedValue(makeWallet())
  mockResolveCountry.mockResolvedValue("US")
  mockMasterGate.mockReturnValue({
    ok: true,
    providerId: "bitcoinCompany",
    countryCode: "US",
    countryKnown: true,
  })
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
  mockClaimCryptoReady.mockReturnValue(true)
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

    // The inline poll asks once: the customer is waiting on this response and
    // the reconcile worker will ask again in seconds anyway.
    expect(mockGetOrder).toHaveBeenCalledTimes(1)
    expect(mockGetOrder).toHaveBeenCalledWith(
      { providerOrderId: "tbc-123", paymentRequest: PAYMENT_REQUEST },
      { retry: false },
    )
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

  describe("claim key", () => {
    // The vendor hands back a claim code the moment the invoice is paid. If the
    // key that seals it cannot be loaded we would take the money and then be
    // unable to store what it bought — so the check runs before any pay.
    it("an unloadable claim key fails the order before paying; no IBEX call", async () => {
      const fault = new GiftCardClaimCryptoError("no key")
      mockClaimCryptoReady.mockReturnValue(fault)

      const res = await purchase()

      expect(res).toBe(fault)
      expect(mockPayInvoice).not.toHaveBeenCalled()
      expect(mockGetOrder).not.toHaveBeenCalled()
      const order = storedOrder()
      expect(order.status).toBe("FAILED")
      expect(order.failureReason).toBe("claim-key-not-configured")
      expect(opsPhases()).toEqual(["order-created", "order-failed"])
      expect(opsEvent("order-failed")).toMatchObject({
        error: "GiftCardClaimCryptoError",
        meta: expect.objectContaining({ reason: "claim-key-not-configured" }),
      })
    })

    it("is checked immediately before the pay, after the vendor order exists", async () => {
      await purchase()
      expect(mockClaimCryptoReady).toHaveBeenCalledTimes(1)
      const ready = mockClaimCryptoReady.mock.invocationCallOrder[0]
      expect(ready).toBeGreaterThan(mockCreateOrder.mock.invocationCallOrder[0])
      expect(ready).toBeLessThan(mockPayInvoice.mock.invocationCallOrder[0])
    })
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

    it("stays null when IBEX answered with no transaction id", async () => {
      mockPayInvoice.mockImplementation(
        async (args: { onResponse?: (r: unknown) => void }) => {
          args.onResponse?.({ transaction: {} })
          return PaymentSendStatus.Pending
        },
      )
      const res = await purchase()
      if (res instanceof Error) throw res
      expect(res.status).toBe("PAYMENT_PENDING")
      expect(res.providerPaymentRef).toBeNull()
    })

    it("stays null on a cached replay, where onResponse is never invoked", async () => {
      // The wrapper returns the cached outcome without running execute, so
      // there is no raw 200 to capture an id from.
      mockPayInvoice.mockImplementation(async () => ({ value: "pending" }))
      const res = await purchase()
      if (res instanceof Error) throw res
      expect(res.status).toBe("PAYMENT_PENDING")
      expect(res.providerPaymentRef).toBeNull()
    })

    it("a cached-replay Success never $sets null over the ref a concurrent attempt recorded", async () => {
      // Attempt A's send returned Pending with ibex-tx-1 and wrote it. Attempt
      // B (replay-resumed from INVOICE_ISSUED) gets the cached Success with no
      // onResponse. Its PAID transition must leave A's ref in place.
      concurrentAttemptWrote({ value: "success" }, "PAYMENT_PENDING", "ibex-tx-1")
      mockGetOrder.mockResolvedValue({ kind: "paidPendingFulfillment" })
      const res = await purchase()
      if (res instanceof Error) throw res
      expect(res.status).toBe("PAID")
      expect(res.providerPaymentRef).toBe("ibex-tx-1")
      const paidTransition = repo.transition.mock.calls.find((c) => c[0].to === "PAID")
      expect(paidTransition?.[0].patch).not.toHaveProperty("providerPaymentRef")
    })

    it("a Failure with no id does not $set null over an existing ref either", async () => {
      concurrentAttemptWrote(PaymentSendStatus.Failure, "PAYMENT_PENDING", "ibex-tx-1")
      const res = await purchase()
      if (res instanceof Error) throw res
      expect(res.status).toBe("PAYMENT_FAILED")
      expect(res.providerPaymentRef).toBe("ibex-tx-1")
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

    it("a same-key replay does not consume the purchase budget", async () => {
      // Polling an order you already own by re-sending its key is free; the
      // budget is for attempts that can reach the vendor.
      repo.seed(makeOrder({ status: "PAID", idempotencyKey: "idem-1" }))
      await purchase()
      expect(mockConsumeLimiter).not.toHaveBeenCalled()
    })

    it("a first attempt is charged to the budget, after the replay lookup and before the gate", async () => {
      await purchase()
      expect(mockConsumeLimiter).toHaveBeenCalledTimes(1)
      expect(mockConsumeLimiter).toHaveBeenCalledWith({
        rateLimitConfig: { key: "gift_card_purchase" },
        keyToConsume: ACCOUNT_ID,
      })
      const limiter = mockConsumeLimiter.mock.invocationCallOrder[0]
      expect(limiter).toBeGreaterThan(
        repo.findByIdempotencyKey.mock.invocationCallOrder[0],
      )
      expect(limiter).toBeLessThan(mockMasterGate.mock.invocationCallOrder[0])
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

    describe("a create that loses the unique-index race", () => {
      const loseRaceTo = (winner: GiftCardOrder | null) =>
        repo.create.mockImplementationOnce(async () => {
          if (winner) repo.seed(winner)
          return new RepositoryError("duplicate key")
        })

      it("replays the winner when its parameters match", async () => {
        loseRaceTo(makeOrder({ id: "order-winner" as GiftCardOrderId, status: "PAID" }))
        const res = await purchase()
        if (res instanceof Error) throw res
        expect(res.id).toBe("order-winner")
        expect(mockCreateOrder).not.toHaveBeenCalled()
        expect(mockReleaseReservation).toHaveBeenCalledWith(ACCOUNT_ID, "res-1")
      })

      it("refuses a winner with different parameters as a key reuse", async () => {
        loseRaceTo(
          makeOrder({
            id: "order-winner" as GiftCardOrderId,
            status: "PAID",
            valueMinor: 5000,
          }),
        )
        const res = await purchase()
        expect(res).toBeInstanceOf(GiftCardIdempotencyKeyReuseError)
        expect(mockCreateOrder).not.toHaveBeenCalled()
      })

      it("surfaces a create failure with no winner as UnknownGiftCardError, never the repository's duplicate-key error", async () => {
        // The duplicate-key error is repository-private: the GraphQL error map
        // does not know it and would turn it into a 500.
        loseRaceTo(null)
        const res = await purchase()
        expect(res).toBeInstanceOf(UnknownGiftCardError)
        expect(res).not.toBeInstanceOf(RepositoryError)
        expect(mockCreateOrder).not.toHaveBeenCalled()
        expect(mockPayInvoice).not.toHaveBeenCalled()
        expect(mockLogger.error).toHaveBeenCalledWith(
          expect.objectContaining({ error: "RepositoryError" }),
          expect.stringContaining("Could not create"),
        )
      })

      it("surfaces a failed re-read the same way", async () => {
        loseRaceTo(null)
        // First lookup is the replay check (no order yet); the second is the
        // post-race re-read, which is the one that faults here.
        repo.findByIdempotencyKey
          .mockResolvedValueOnce(new GiftCardOrderNotFoundError())
          .mockResolvedValueOnce(new UnknownRepositoryError("mongo"))
        expect(await purchase()).toBeInstanceOf(UnknownGiftCardError)
        expect(mockLogger.error).toHaveBeenCalledWith(
          expect.objectContaining({ reread: "UnknownRepositoryError" }),
          expect.stringContaining("Could not create"),
        )
      })
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

      it("an INVOICE_ISSUED order with no payment request is returned as-is: nothing to pay", async () => {
        const existing = issued({ paymentRequest: null })
        const res = await purchase()
        expect(res).toBe(existing)
        expect(mockPayInvoice).not.toHaveBeenCalled()
        expect(repo.transition).not.toHaveBeenCalled()
      })

      it("the resume checks the claim key too: an unloadable key fails the order, no IBEX call", async () => {
        const existing = issued()
        const fault = new GiftCardClaimCryptoError("no key")
        mockClaimCryptoReady.mockReturnValue(fault)
        const res = await purchase()
        expect(res).toBe(fault)
        expect(mockPayInvoice).not.toHaveBeenCalled()
        expect(repo.store.get(existing.id)?.status).toBe("FAILED")
        expect(repo.store.get(existing.id)?.failureReason).toBe(
          "claim-key-not-configured",
        )
      })

      it("a late Success on a row the worker already EXPIRED revives it: EXPIRED -> PAID -> FULFILLED", async () => {
        // The send was in flight at IBEX when expiresAt passed and the worker
        // expired the row. IBEX then reports Success: the money left, and the
        // order must say so rather than lose the payment under EXPIRED.
        const existing = issued()
        mockPayInvoice.mockImplementation(async () => {
          const expired = await repo.transition({
            id: existing.id,
            from: ["INVOICE_ISSUED"],
            to: "EXPIRED",
            reason: "expired",
            patch: { failureReason: "expired" },
          })
          if (expired instanceof Error) throw expired
          return PaymentSendStatus.Success
        })
        const res = await purchase()
        if (res instanceof Error) throw res
        expect(res.status).toBe("FULFILLED")
        expect(res.paidSats).toBe(40_100)
        expect(res.statusHistory.map((h) => h.status)).toEqual([
          "CREATED",
          "INVOICE_ISSUED",
          "EXPIRED",
          "PAID",
          "FULFILLED",
        ])
        expect(res.statusHistory[3].reason).toBe("payment-settled-after-expiry")
        expect(opsPhases()).toEqual(["order-paid", "order-fulfilled"])
        expect(opsEvent("paid-not-recorded")).toBeUndefined()
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

    it("rate limited: refused before the gate, the catalog or the vendor", async () => {
      mockConsumeLimiter.mockResolvedValue(new GiftCardPurchaseRateLimiterExceededError())
      const res = await purchase()
      expect(res).toBeInstanceOf(GiftCardPurchaseRateLimiterExceededError)
      // The replay lookup runs first (a replay is free), so the account and
      // wallet are read; nothing past the budget is.
      expect(repo.findByIdempotencyKey).toHaveBeenCalledTimes(1)
      expect(mockMasterGate).not.toHaveBeenCalled()
      expect(mockGetGiftCardProduct).not.toHaveBeenCalled()
      expect(mockQuote).not.toHaveBeenCalled()
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

    it("same provider, but another country's catalog", async () => {
      // API.md: a product not sold in the account's country is refused. The
      // provider check cannot see that — one provider serves many countries.
      mockGetGiftCardProduct.mockResolvedValue(makeProduct({ countryCode: "GB" }))
      const res = await purchase()
      expect(res).toBeInstanceOf(GiftCardProductNotAvailableInCountryError)
      expect(mockQuote).not.toHaveBeenCalled()
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

    it("quantity above the product's own maxQuantity", async () => {
      mockGetGiftCardProduct.mockResolvedValue(makeProduct({ maxQuantity: 1 }))
      const res = await purchase({ quantity: 2 })
      expect(res).toBeInstanceOf(GiftCardInvalidValueError)
      expect(mockQuote).not.toHaveBeenCalled()
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

  describe("product country", () => {
    it("compares normalised codes, so a lower-case catalog row buys fine", async () => {
      mockGetGiftCardProduct.mockResolvedValue(makeProduct({ countryCode: "us" }))
      const res = await purchase()
      if (res instanceof Error) throw res
      expect(res.status).toBe("FULFILLED")
    })

    it("skips the comparison when the account's country is unknown (XX)", async () => {
      // We cannot know where the user is; the routed provider's catalog is all
      // we have. Refusing would make the feature unusable for anyone without a
      // resolvable phone country.
      mockMasterGate.mockReturnValue({
        ok: true,
        providerId: "bitcoinCompany",
        countryCode: "XX",
        countryKnown: false,
      })
      mockGetGiftCardProduct.mockResolvedValue(makeProduct({ countryCode: "GB" }))
      const res = await purchase()
      if (res instanceof Error) throw res
      expect(res.status).toBe("FULFILLED")
      expect(mockPayInvoice).toHaveBeenCalledTimes(1)
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

    it("Failure whose PAYMENT_FAILED transition faults still returns the order, logged and reported", async () => {
      // Nothing left the wallet, so this is not the paid-not-recorded page: the
      // client sees the row's true state on its next poll.
      mockPayInvoice.mockResolvedValue(PaymentSendStatus.Failure)
      failTransitionTo("PAYMENT_FAILED", new UnknownRepositoryError("mongo"))
      const res = await purchase()
      if (res instanceof Error) throw res
      expect(res.status).toBe("INVOICE_ISSUED")
      expect(repo.store.get(res.id)?.status).toBe("INVOICE_ISSUED")
      expect(opsPhases()).toEqual(["order-created", "order-failed"])
      expect(opsEvent("paid-not-recorded")).toBeUndefined()
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: res.id, error: "UnknownRepositoryError" }),
        expect.stringContaining("PAYMENT_FAILED"),
      )
    })

    it("Failure after a concurrent attempt already recorded an outcome returns that row and does not report twice", async () => {
      concurrentAttemptWrote(PaymentSendStatus.Failure, "PAID", "ibex-tx-1")
      const res = await purchase()
      if (res instanceof Error) throw res
      expect(res.status).toBe("PAID")
      expect(res.providerPaymentRef).toBe("ibex-tx-1")
      expect(opsPhases()).toEqual(["order-created"])
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

      it("a PAYMENT_PENDING transition that faults still returns the order and pages paid-not-recorded", async () => {
        // IBEX may have moved money and the row cannot say so. An error here
        // would read as "buy again".
        mockPayInvoice.mockImplementation(
          async (args: { onResponse?: (r: unknown) => void }) => {
            args.onResponse?.({ transaction: { id: "ibex-tx-1" } })
            return new IbexError(new Error("connection reset"))
          },
        )
        failTransitionTo("PAYMENT_PENDING", new UnknownRepositoryError("mongo"))
        const res = await purchase()
        if (res instanceof Error) throw res
        expect(res.status).toBe("INVOICE_ISSUED")
        expect(opsPhases()).toEqual(["order-created", "paid-not-recorded"])
        expect(opsEvent("paid-not-recorded")).toMatchObject({
          flow: "giftcard",
          status: "failed",
          error: "UnknownRepositoryError",
          meta: expect.objectContaining({
            orderId: res.id,
            providerPaymentRef: "ibex-tx-1",
            intendedStatus: "PAYMENT_PENDING",
          }),
        })
      })
    })

    describe("a busy idempotency lock (concurrent same-key attempt in flight)", () => {
      // IBEX was not asked by THIS call; the attempt holding the lock owns the
      // outcome and will record it, ref included. Writing PAYMENT_PENDING here
      // would race that transition and could overwrite its ref with null.
      it.each([
        [
          "ResourceAttemptsLockServiceError",
          () => new ResourceAttemptsLockServiceError(),
        ],
        ["UnknownLockServiceError", () => new UnknownLockServiceError()],
      ])(
        "%s with nothing recorded yet returns the row as it stands, writing nothing",
        async (_label, make) => {
          mockPayInvoice.mockResolvedValue(make())
          const res = await purchase()
          if (res instanceof Error) throw res
          expect(res.status).toBe("INVOICE_ISSUED")
          expect(res.providerPaymentRef).toBeNull()
          expect(repo.transition).toHaveBeenCalledTimes(1) // CREATED → INVOICE_ISSUED only
          expect(opsPhases()).toEqual(["order-created"])
          expect(mockGetOrder).not.toHaveBeenCalled()
        },
      )

      it("while the first attempt ends Pending with ref ibex-tx-1 -> PAYMENT_PENDING with that ref intact", async () => {
        // Before the fix this replay wrote INVOICE_ISSUED → PAYMENT_PENDING with
        // a null ref — clobbering the first attempt's outcome and dropping the
        // one handle the worker has to re-query IBEX.
        concurrentAttemptWrote(
          new ResourceAttemptsLockServiceError() as unknown as { value: string },
          "PAYMENT_PENDING",
          "ibex-tx-1",
        )
        const res = await purchase()
        if (res instanceof Error) throw res
        expect(res.status).toBe("PAYMENT_PENDING")
        expect(res.providerPaymentRef).toBe("ibex-tx-1")
        // Only the concurrent attempt's transition touched the row.
        expect(
          repo.transition.mock.calls.filter((c) => c[0].to === "PAYMENT_PENDING"),
        ).toHaveLength(1)
        expect(opsPhases()).toEqual(["order-created"])
      })

      it("while the first attempt ends PAID -> that PAID row, untouched", async () => {
        concurrentAttemptWrote(
          new ResourceAttemptsLockServiceError() as unknown as { value: string },
          "PAID",
          "ibex-tx-1",
        )
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

    describe("Success that the row cannot record (never a bare error once money moved)", () => {
      const ibexSuccessWithRef = () =>
        mockPayInvoice.mockImplementation(
          async (args: { onResponse?: (r: unknown) => void }) => {
            args.onResponse?.({ transaction: { id: "ibex-tx-1" } })
            return PaymentSendStatus.Success
          },
        )

      it("PAID transition repository fault -> the order as last known, plus a Critical paid-not-recorded page", async () => {
        ibexSuccessWithRef()
        failTransitionTo("PAID", new UnknownRepositoryError("mongo"))
        const res = await purchase()
        expect(res).not.toBeInstanceOf(Error)
        if (res instanceof Error) return
        expect(res.status).toBe("INVOICE_ISSUED")
        expect(mockGetOrder).not.toHaveBeenCalled()
        expect(opsPhases()).toEqual(["order-created", "paid-not-recorded"])
        expect(opsEvent("paid-not-recorded")).toMatchObject({
          flow: "giftcard",
          status: "failed",
          accountId: ACCOUNT_ID,
          error: "UnknownRepositoryError",
          meta: expect.objectContaining({
            orderId: res.id,
            providerPaymentRef: "ibex-tx-1",
            intendedStatus: "PAID",
          }),
        })
        expect(mockLogger.error).toHaveBeenCalledWith(
          expect.objectContaining({
            orderId: res.id,
            providerPaymentRef: "ibex-tx-1",
            error: "UnknownRepositoryError",
          }),
          expect.stringContaining("could not record"),
        )
      })

      it.each(["PAID", "FULFILLED"] as const)(
        "a concurrent winner already %s -> that row, no error, no page",
        async (status) => {
          const real = repo.transition.getMockImplementation()
          mockPayInvoice.mockImplementation(async () => {
            const order = storedOrder()
            const paid = await real?.({
              id: order.id,
              from: ["INVOICE_ISSUED"],
              to: "PAID",
              reason: "payment-settled",
              patch: { paidSats: 40_100 as Satoshis, providerPaymentRef: "ibex-tx-1" },
            })
            if (status === "FULFILLED" && !(paid instanceof Error)) {
              await real?.({
                id: order.id,
                from: ["PAID"],
                to: "FULFILLED",
                reason: "vendor-fulfilled",
                patch: { claimCiphertext: "THEIRS", claimKeyId: "k1" },
              })
            }
            return PaymentSendStatus.Success
          })
          const res = await purchase()
          if (res instanceof Error) throw res
          expect(res.status).toBe(status)
          expect(res.providerPaymentRef).toBe("ibex-tx-1")
          expect(opsEvent("paid-not-recorded")).toBeUndefined()
          // The loser neither re-polls the vendor nor re-reports PAID.
          expect(mockGetOrder).not.toHaveBeenCalled()
          expect(opsPhases()).toEqual(["order-created"])
        },
      )

      it("a row in a state that contradicts Success (PAYMENT_FAILED) -> the order as last known, plus the page", async () => {
        concurrentAttemptWrote(PaymentSendStatus.Success, "PAYMENT_FAILED", null)
        const res = await purchase()
        if (res instanceof Error) throw res
        expect(res.status).toBe("INVOICE_ISSUED")
        expect(opsEvent("paid-not-recorded")).toMatchObject({
          meta: expect.objectContaining({
            intendedStatus: "PAID",
            rowStatus: "PAYMENT_FAILED",
          }),
        })
      })

      it("a failed re-read after the lost transition -> the order as last known, plus the page", async () => {
        ibexSuccessWithRef()
        failTransitionTo("PAID", new GiftCardOrderStateError("raced"))
        repo.findById.mockResolvedValueOnce(new UnknownRepositoryError("mongo"))
        const res = await purchase()
        if (res instanceof Error) throw res
        expect(res.status).toBe("INVOICE_ISSUED")
        expect(opsEvent("paid-not-recorded")).toMatchObject({
          error: "UnknownRepositoryError",
          meta: expect.objectContaining({ rowStatus: "unreadable" }),
        })
      })
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
