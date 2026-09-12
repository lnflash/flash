import {
  GiftCardClaimCryptoError,
  GiftCardOrderStateError,
  GiftCardProviderUnavailableError,
  GiftCardVendorUnavailableError,
} from "@domain/gift-cards"

const mockEncrypt = jest.fn()
const mockGetProvider = jest.fn()
const mockGetOrder = jest.fn()
const mockNotifyOpsEvent = jest.fn()
const mockSendFulfilledPush = jest.fn()
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }

let repo: FakeOrdersRepo

jest.mock("@services/mongoose", () => ({
  GiftCardOrdersRepository: () => repo,
}))
jest.mock("@services/gift-cards/claim-crypto", () => ({
  encryptGiftCardClaim: (...a: unknown[]) => mockEncrypt(...a),
}))
jest.mock("@services/gift-cards/registry", () => ({
  getRegisteredGiftCardProviderOrError: (...a: unknown[]) => mockGetProvider(...a),
}))
jest.mock("@app/gift-cards/send-fulfilled-notification", () => ({
  sendGiftCardFulfilledNotificationBestEffort: (...a: unknown[]) =>
    mockSendFulfilledPush(...a),
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

import { fetchAndSettle, settleOrderFromVendor } from "@app/gift-cards/settle-order"

import {
  allMockCallText,
  makeFakeOrdersRepo,
  makeOrder,
  NOW_MS,
  type FakeOrdersRepo,
} from "./fixtures"

const CLAIM_CODE = "CLAIM-CODE-SECRET-9f8e7d"
const CLAIM: GiftCardClaim = {
  codes: [{ label: "Code", value: CLAIM_CODE }],
  claimLink: "https://vendor.example/claim/SECRET-LINK-TOKEN",
  barcode: null,
}
const FULFILLED = { kind: "fulfilled", claim: CLAIM } as const

const paidOrder = (overrides: Partial<GiftCardOrder> = {}) =>
  repo.seed(
    makeOrder({
      status: "PAID",
      providerOrderId: "tbc-123" as GiftCardProviderOrderId,
      paymentRequest: "lnbc1...",
      invoiceSats: 40_100 as Satoshis,
      paidSats: 40_100 as Satoshis,
      statusHistory: [
        { status: "CREATED", at: new Date(NOW_MS - 3000), reason: null },
        { status: "INVOICE_ISSUED", at: new Date(NOW_MS - 2000), reason: null },
        { status: "PAID", at: new Date(NOW_MS - 1000), reason: null },
      ],
      ...overrides,
    }),
  )

const opsPhases = () => mockNotifyOpsEvent.mock.calls.map((c) => c[0].phase)

beforeEach(() => {
  jest.clearAllMocks()
  repo = makeFakeOrdersRepo()
  mockEncrypt.mockReturnValue({ ciphertext: "ENCRYPTED", keyId: "k1" })
  mockGetOrder.mockResolvedValue(FULFILLED)
  mockGetProvider.mockReturnValue({ id: "bitcoinCompany", getOrder: mockGetOrder })
  mockSendFulfilledPush.mockResolvedValue(undefined)
})

describe("settleOrderFromVendor", () => {
  describe("fulfilled", () => {
    it("PAID -> FULFILLED with the encrypted claim, an ops event and a push", async () => {
      const order = paidOrder()
      const res = await settleOrderFromVendor(order, FULFILLED)

      expect(res).not.toBeInstanceOf(Error)
      if (res instanceof Error) return
      expect(res.status).toBe("FULFILLED")
      expect(res.claimCiphertext).toBe("ENCRYPTED")
      expect(res.claimKeyId).toBe("k1")
      expect(res.fulfilledAt).toBeInstanceOf(Date)
      expect(mockEncrypt).toHaveBeenCalledWith(CLAIM)

      expect(opsPhases()).toEqual(["order-fulfilled"])
      expect(mockNotifyOpsEvent.mock.calls[0][0]).toMatchObject({
        flow: "giftcard",
        status: "success",
        amount: { value: "25.00", currency: "USD" },
        meta: { orderId: order.id, providerId: "bitcoinCompany" },
      })
      expect(mockSendFulfilledPush).toHaveBeenCalledWith({
        accountId: order.accountId,
        orderId: order.id,
        brand: "Amazon",
        valueMinor: 2500,
        quantity: 1,
        currency: "USD",
      })
    })

    it("never stores, logs, traces or reports the plaintext claim", async () => {
      const order = paidOrder()
      await settleOrderFromVendor(order, FULFILLED)

      const stored = JSON.stringify(repo.store.get(order.id))
      expect(stored).not.toContain(CLAIM_CODE)
      expect(stored).not.toContain("SECRET-LINK-TOKEN")

      const transitionArgs = JSON.stringify(repo.transition.mock.calls)
      expect(transitionArgs).not.toContain(CLAIM_CODE)

      const leaked = allMockCallText(
        mockNotifyOpsEvent,
        mockSendFulfilledPush,
        mockLogger.info,
        mockLogger.warn,
        mockLogger.error,
      )
      expect(leaked).not.toContain(CLAIM_CODE)
      expect(leaked).not.toContain("SECRET-LINK-TOKEN")
    })

    it("is idempotent on an already-FULFILLED order", async () => {
      const order = repo.seed(
        makeOrder({ status: "FULFILLED", claimCiphertext: "OLD", claimKeyId: "k0" }),
      )
      const res = await settleOrderFromVendor(order, FULFILLED)
      expect(res).toBe(order)
      expect(mockEncrypt).not.toHaveBeenCalled()
      expect(repo.transition).not.toHaveBeenCalled()
      expect(mockSendFulfilledPush).not.toHaveBeenCalled()
      expect(mockNotifyOpsEvent).not.toHaveBeenCalled()
    })

    it("PAYMENT_PENDING -> PAID -> FULFILLED when the vendor saw the payment first", async () => {
      const order = repo.seed(
        makeOrder({
          status: "PAYMENT_PENDING",
          invoiceSats: 40_100 as Satoshis,
          providerOrderId: "tbc-123" as GiftCardProviderOrderId,
        }),
      )
      const res = await settleOrderFromVendor(order, FULFILLED)
      expect(res).not.toBeInstanceOf(Error)
      if (res instanceof Error) return
      expect(res.status).toBe("FULFILLED")
      expect(res.paidSats).toBe(40_100)
      expect(res.statusHistory.map((h) => h.status)).toEqual([
        "PAYMENT_PENDING",
        "PAID",
        "FULFILLED",
      ])
      expect(opsPhases()).toEqual(["order-paid", "order-fulfilled"])
    })

    it("INVOICE_ISSUED -> PAID -> FULFILLED (crash between pay and PAID)", async () => {
      const order = repo.seed(
        makeOrder({
          status: "INVOICE_ISSUED",
          providerOrderId: "tbc-123" as GiftCardProviderOrderId,
        }),
      )
      const res = await settleOrderFromVendor(order, FULFILLED)
      if (res instanceof Error) throw res
      expect(res.status).toBe("FULFILLED")
      // No invoiceSats recorded yet, so the quote is the best record of what was paid.
      expect(res.paidSats).toBe(40_000)
    })

    it("a terminal non-paid order that the vendor says is fulfilled pages", async () => {
      const order = repo.seed(makeOrder({ status: "PAYMENT_FAILED" }))
      const res = await settleOrderFromVendor(order, FULFILLED)
      expect(res).toBeInstanceOf(GiftCardOrderStateError)
      expect(mockEncrypt).not.toHaveBeenCalled()
      expect(opsPhases()).toEqual(["vendor-fulfilled-unexpected"])
      expect(mockNotifyOpsEvent.mock.calls[0][0].status).toBe("failed")
    })

    it("an encryption failure leaves the order PAID and pages", async () => {
      mockEncrypt.mockReturnValue(new GiftCardClaimCryptoError("no key"))
      const order = paidOrder()
      const res = await settleOrderFromVendor(order, FULFILLED)
      expect(res).toBeInstanceOf(GiftCardClaimCryptoError)
      expect(repo.store.get(order.id)?.status).toBe("PAID")
      expect(repo.store.get(order.id)?.claimCiphertext).toBeNull()
      expect(opsPhases()).toEqual(["claim-encrypt-failed"])
      expect(mockSendFulfilledPush).not.toHaveBeenCalled()
    })

    it("losing the FULFILLED race returns the winner's order", async () => {
      const order = paidOrder()
      const realTransition = repo.transition.getMockImplementation()
      repo.transition.mockImplementationOnce(async (args) => {
        // Another settler got there first.
        await realTransition?.({
          ...args,
          patch: { ...args.patch, claimCiphertext: "THEIRS" },
        })
        return new GiftCardOrderStateError("raced")
      })
      const res = await settleOrderFromVendor(order, FULFILLED)
      if (res instanceof Error) throw res
      expect(res.status).toBe("FULFILLED")
      expect(res.claimCiphertext).toBe("THEIRS")
      // The loser does not notify twice.
      expect(mockSendFulfilledPush).not.toHaveBeenCalled()
    })
  })

  describe("failed / refunded", () => {
    for (const kind of ["failed", "refunded"] as const) {
      it(`${kind} on PAID -> REFUND_REQUIRED and pages`, async () => {
        const order = paidOrder()
        const res = await settleOrderFromVendor(order, {
          kind,
          reason: "Vendor cancelled",
        })
        if (res instanceof Error) throw res
        expect(res.status).toBe("REFUND_REQUIRED")
        expect(res.failureReason).toBe(`vendor-${kind}: Vendor cancelled`)
        expect(mockNotifyOpsEvent).toHaveBeenCalledTimes(1)
        expect(mockNotifyOpsEvent.mock.calls[0][0]).toMatchObject({
          flow: "giftcard",
          phase: "refund-required",
          status: "failed",
          error: `vendor-${kind}`,
          amount: { value: "25.00", currency: "USD" },
          meta: { orderId: order.id, reason: "Vendor cancelled" },
        })
      })
    }

    it("failed on INVOICE_ISSUED -> FAILED (nothing was paid)", async () => {
      const order = repo.seed(makeOrder({ status: "INVOICE_ISSUED" }))
      const res = await settleOrderFromVendor(order, {
        kind: "failed",
        reason: "expired",
      })
      if (res instanceof Error) throw res
      expect(res.status).toBe("FAILED")
      expect(opsPhases()).toEqual(["order-failed"])
    })

    it("failed on PAYMENT_PENDING is left for the payment re-read", async () => {
      const order = repo.seed(makeOrder({ status: "PAYMENT_PENDING" }))
      const res = await settleOrderFromVendor(order, { kind: "failed", reason: "x" })
      expect(res).toBe(order)
      expect(repo.transition).not.toHaveBeenCalled()
      expect(mockLogger.warn).toHaveBeenCalled()
    })

    it("refunded on an already-terminal order is a no-op", async () => {
      const order = repo.seed(makeOrder({ status: "REFUND_REQUIRED" }))
      const res = await settleOrderFromVendor(order, { kind: "refunded", reason: "x" })
      expect(res).toBe(order)
      expect(repo.transition).not.toHaveBeenCalled()
    })
  })

  describe("non-terminal vendor statuses", () => {
    for (const kind of ["awaitingPayment", "paidPendingFulfillment"] as const) {
      it(`${kind} returns the order untouched`, async () => {
        const order = paidOrder()
        const res = await settleOrderFromVendor(order, { kind })
        expect(res).toBe(order)
        expect(repo.transition).not.toHaveBeenCalled()
        expect(mockNotifyOpsEvent).not.toHaveBeenCalled()
      })
    }
  })
})

describe("fetchAndSettle", () => {
  it("asks the order's provider by providerOrderId + paymentRequest and settles", async () => {
    const order = paidOrder()
    const res = await fetchAndSettle(order)
    if (res instanceof Error) throw res
    expect(mockGetProvider).toHaveBeenCalledWith("bitcoinCompany")
    expect(mockGetOrder).toHaveBeenCalledWith({
      providerOrderId: "tbc-123",
      paymentRequest: "lnbc1...",
    })
    expect(res.status).toBe("FULFILLED")
  })

  it("returns the provider lookup error without touching the order", async () => {
    mockGetOrder.mockResolvedValue(new GiftCardVendorUnavailableError())
    const order = paidOrder()
    const res = await fetchAndSettle(order)
    expect(res).toBeInstanceOf(GiftCardVendorUnavailableError)
    expect(repo.transition).not.toHaveBeenCalled()
  })

  it("resolves the provider by registration, not by the enabled switch", async () => {
    // The kill switch must not strand an order that already exists: settlement
    // asks the registry for the registered adapter, never the enabled one.
    const res = await fetchAndSettle(paidOrder())
    if (res instanceof Error) throw res
    expect(mockGetProvider).toHaveBeenCalledWith("bitcoinCompany")
    expect(res.status).toBe("FULFILLED")
  })

  it("returns an error when the provider is not registered", async () => {
    mockGetProvider.mockReturnValue(new GiftCardProviderUnavailableError())
    const res = await fetchAndSettle(paidOrder())
    expect(res).toBeInstanceOf(GiftCardProviderUnavailableError)
    expect(mockGetOrder).not.toHaveBeenCalled()
  })

  it("refuses an order with no provider order id", async () => {
    const res = await fetchAndSettle(paidOrder({ providerOrderId: null }))
    expect(res).toBeInstanceOf(GiftCardOrderStateError)
    expect(mockGetOrder).not.toHaveBeenCalled()
  })
})
