import {
  GiftCardClaimCryptoError,
  GiftCardVendorUnavailableError,
  UnknownGiftCardError,
} from "@domain/gift-cards"
import { IbexError } from "@services/ibex/errors"

import {
  __resetGiftCardReconcileStateForTest,
  GIFT_CARD_OPEN_STATUSES,
  GIFT_CARD_PAID_TIMEOUT_MS,
  GIFT_CARD_PAYMENT_UNRESOLVED_GRACE_MS,
  GIFT_CARD_RECONCILE_LOCK_KEY,
  hasOpenGiftCardOrders,
  nextGiftCardPollAt,
  reconcileGiftCardOrders,
  reconcileGiftCardOrdersJob,
  startGiftCardReconcileInterval,
} from "@app/gift-cards/reconcile-orders"

import {
  makeFakeOrdersRepo,
  makeGiftCardsConfig,
  makeOrder,
  NOW_MS,
  type FakeOrdersRepo,
} from "./fixtures"

const mockGetTransactionDetails = jest.fn()
const mockFetchAndSettle = jest.fn()
const mockFetchVendorStatus = jest.fn()
const mockSettleFromVendor = jest.fn()
const mockNotifyOpsEvent = jest.fn()
const mockRedisSet = jest.fn()
const mockRedisGet = jest.fn()
const mockRedisDel = jest.fn()
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }

let repo: FakeOrdersRepo
let mockConfig = makeGiftCardsConfig()

jest.mock("@config", () => ({
  get GiftCardsConfig() {
    return mockConfig
  },
}))
jest.mock("@services/mongoose", () => ({
  GiftCardOrdersRepository: () => repo,
}))
jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: {
    getTransactionDetails: (...a: unknown[]) => mockGetTransactionDetails(...a),
  },
}))
jest.mock("@app/gift-cards/settle-order", () => ({
  fetchAndSettle: (...a: unknown[]) => mockFetchAndSettle(...a),
  fetchVendorOrderStatus: (...a: unknown[]) => mockFetchVendorStatus(...a),
  settleOrderFromVendor: (...a: unknown[]) => mockSettleFromVendor(...a),
}))
jest.mock("@services/redis", () => ({
  redis: {
    set: (...a: unknown[]) => mockRedisSet(...a),
    get: (...a: unknown[]) => mockRedisGet(...a),
    del: (...a: unknown[]) => mockRedisDel(...a),
  },
}))
jest.mock("@services/alerts/ops-events", () => ({
  notifyOpsEvent: (...a: unknown[]) => mockNotifyOpsEvent(...a),
}))
jest.mock("@services/logger", () => ({
  baseLogger: {
    info: (...a: unknown[]) => mockLogger.info(...a),
    warn: (...a: unknown[]) => mockLogger.warn(...a),
    error: (...a: unknown[]) => mockLogger.error(...a),
    // Closures, not the object: `child()` runs at the module's load, which is
    // before this spec's `const mockLogger` has been initialised.
    child: () => ({
      info: (...a: unknown[]) => mockLogger.info(...a),
      warn: (...a: unknown[]) => mockLogger.warn(...a),
      error: (...a: unknown[]) => mockLogger.error(...a),
    }),
  },
}))
jest.mock("@services/tracing", () => ({
  addAttributesToCurrentSpan: jest.fn(),
  recordExceptionInCurrentSpan: jest.fn(),
}))

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const PAYMENT_HASH = "b".repeat(64)

let clock = NOW_MS
const at = (offsetMs: number) => new Date(NOW_MS + offsetMs)
const runAt = (offsetMs: number) => {
  clock = NOW_MS + offsetMs
  jest.setSystemTime(clock)
  return reconcileGiftCardOrders(new Date(clock))
}

const paidOrder = (id: string, paidAtOffsetMs = 0) =>
  repo.seed(
    makeOrder({
      id: id as GiftCardOrderId,
      status: "PAID",
      providerOrderId: `tbc-${id}` as GiftCardProviderOrderId,
      paymentHash: PAYMENT_HASH,
      providerPaymentRef: "ibex-tx",
      invoiceSats: 40_100 as Satoshis,
      statusHistory: [
        { status: "CREATED", at: at(paidAtOffsetMs - 2000), reason: null },
        { status: "INVOICE_ISSUED", at: at(paidAtOffsetMs - 1000), reason: null },
        { status: "PAID", at: at(paidAtOffsetMs), reason: null },
      ],
      updatedAt: at(paidAtOffsetMs),
    }),
  )

// The `getTransactionDetails` 200 for a sent payment: the same payment-level
// status fields the pay response carries. 1 IN_FLIGHT, 2 SUCCEEDED, 3 FAILED.
const ibexTransaction = (statusId: number) => ({
  id: "ibex-tx",
  accountId: "wallet",
  payment: {
    hash: PAYMENT_HASH,
    statusId,
    status: { id: statusId },
    failureId: statusId === 3 ? 1 : 0,
  },
})

/** The vendor reports the card shipped: `settleOrderFromVendor` lands on FULFILLED. */
const vendorFulfils = () =>
  mockFetchAndSettle.mockImplementation(async (o: GiftCardOrder) => {
    const fulfilled: GiftCardOrder = {
      ...o,
      status: "FULFILLED",
      paidSats: o.paidSats ?? o.invoiceSats,
      statusHistory: [
        ...o.statusHistory,
        ...(o.status === "PAID"
          ? []
          : [
              {
                status: "PAID" as const,
                at: new Date(clock),
                reason: "vendor-reported-fulfilled",
              },
            ]),
        { status: "FULFILLED" as const, at: new Date(clock), reason: "vendor-fulfilled" },
      ],
    }
    repo.store.set(o.id, fulfilled)
    return fulfilled
  })

beforeEach(() => {
  jest.clearAllMocks()
  jest.useFakeTimers({ now: NOW_MS })
  clock = NOW_MS
  __resetGiftCardReconcileStateForTest()
  repo = makeFakeOrdersRepo()
  mockConfig = makeGiftCardsConfig()
  mockRedisSet.mockResolvedValue("OK")
  mockRedisGet.mockImplementation(async () => mockRedisSet.mock.calls[0]?.[1] ?? null)
  mockRedisDel.mockResolvedValue(1)
  mockGetTransactionDetails.mockResolvedValue(new IbexError(new Error("not found")))
  mockFetchAndSettle.mockImplementation(async (order: GiftCardOrder) => order)
  // The unaccounted-payment path asks the vendor in two halves (it needs the
  // vendor's own answer, not just its effect on the order). By default the
  // vendor says "still working" and settling delegates to `mockFetchAndSettle`,
  // so `vendorFulfils()` drives both paths the same way.
  mockFetchVendorStatus.mockResolvedValue({ kind: "paidPendingFulfillment" })
  mockSettleFromVendor.mockImplementation(async (order: GiftCardOrder) =>
    mockFetchAndSettle(order),
  )
})

afterEach(() => {
  jest.useRealTimers()
})

describe("nextGiftCardPollAt", () => {
  it("follows 5s, 15s, 60s, 5m, then every 15m from the PAID transition", () => {
    const paid = NOW_MS
    let last: number | undefined
    const dueTimes: number[] = []
    for (let i = 0; i < 6; i += 1) {
      const next = nextGiftCardPollAt(paid, last)
      dueTimes.push(next - paid)
      last = next
    }
    expect(dueTimes).toEqual([
      5 * SECOND,
      20 * SECOND,
      80 * SECOND,
      380 * SECOND,
      380 * SECOND + 15 * MINUTE,
      380 * SECOND + 30 * MINUTE,
    ])
  })

  it("never schedules before the PAID transition", () => {
    expect(nextGiftCardPollAt(NOW_MS, NOW_MS - HOUR)).toBe(NOW_MS + 5 * SECOND)
  })
})

describe("reconcileGiftCardOrders", () => {
  describe("lock", () => {
    it("does no work when another worker holds the lock", async () => {
      mockRedisSet.mockResolvedValue(null)
      paidOrder("a", -10 * SECOND)
      const res = await runAt(0)
      expect(res).toEqual({
        scanned: 0,
        fulfilled: 0,
        refundRequired: 0,
        expired: 0,
        paymentSettled: 0,
        finalPollFailed: 0,
        skipped: "lock-held",
      })
      expect(repo.listByStatus).not.toHaveBeenCalled()
      expect(mockRedisDel).not.toHaveBeenCalled()
    })

    it("acquires with NX + 5 minute TTL and releases only its own token", async () => {
      await runAt(0)
      const [key, token, px, ttl, nx] = mockRedisSet.mock.calls[0]
      expect(key).toBe(GIFT_CARD_RECONCILE_LOCK_KEY)
      expect(typeof token).toBe("string")
      expect(px).toBe("PX")
      expect(ttl).toBe(5 * MINUTE)
      expect(nx).toBe("NX")
      expect(mockRedisDel).toHaveBeenCalledWith(GIFT_CARD_RECONCILE_LOCK_KEY)
    })

    it("leaves a lock that now belongs to someone else", async () => {
      mockRedisGet.mockResolvedValue("someone-elses-token")
      await runAt(0)
      expect(mockRedisDel).not.toHaveBeenCalled()
    })

    it("a Redis fault on acquire is returned, not thrown", async () => {
      mockRedisSet.mockRejectedValue(new Error("ECONNREFUSED"))
      const res = await runAt(0)
      expect(res).toBeInstanceOf(UnknownGiftCardError)
    })
  })

  describe("expiry", () => {
    it("CREATED past expiresAt -> EXPIRED", async () => {
      repo.seed(
        makeOrder({ id: "c" as GiftCardOrderId, status: "CREATED", expiresAt: at(-1) }),
      )
      const res = await runAt(0)
      if (res instanceof Error) throw res
      expect(res.expired).toBe(1)
      expect(repo.store.get("c")?.status).toBe("EXPIRED")
      expect(mockNotifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: "order-failed",
          meta: expect.objectContaining({ reason: "expired" }),
        }),
      )
    })

    it("INVOICE_ISSUED past expiresAt never consults IBEX: no path writes a ref without leaving the state", async () => {
      // Every transition that captures an IBEX transaction id also leaves
      // INVOICE_ISSUED in the same write, so an INVOICE_ISSUED row has nothing
      // to re-read. The vendor is the only party who can vouch for it.
      repo.seed(
        makeOrder({
          id: "i" as GiftCardOrderId,
          status: "INVOICE_ISSUED",
          providerOrderId: "tbc-i" as GiftCardProviderOrderId,
          paymentHash: PAYMENT_HASH,
          expiresAt: at(-1),
        }),
      )
      const res = await runAt(0)
      if (res instanceof Error) throw res
      expect(mockGetTransactionDetails).not.toHaveBeenCalled()
      expect(mockFetchVendorStatus).toHaveBeenCalledTimes(1)
      expect(res.expired).toBe(1)
      expect(repo.store.get("i")?.status).toBe("EXPIRED")
    })

    it("INVOICE_ISSUED past expiresAt with no vendor order id -> EXPIRED without a vendor call", async () => {
      repo.seed(
        makeOrder({
          id: "i" as GiftCardOrderId,
          status: "INVOICE_ISSUED",
          providerOrderId: null,
          expiresAt: at(-1),
        }),
      )
      const res = await runAt(0)
      if (res instanceof Error) throw res
      expect(mockFetchVendorStatus).not.toHaveBeenCalled()
      expect(res.expired).toBe(1)
    })

    it("INVOICE_ISSUED past expiresAt with no ref asks the vendor; fulfilled -> FULFILLED, not EXPIRED", async () => {
      // The crash-between-IBEX-call-and-transition window: IBEX cannot be
      // asked, the vendor can. A shipped card is proof of payment.
      vendorFulfils()
      const order = repo.seed(
        makeOrder({
          id: "i" as GiftCardOrderId,
          status: "INVOICE_ISSUED",
          providerOrderId: "tbc-i" as GiftCardProviderOrderId,
          paymentRequest: "lnbc1...",
          paymentHash: PAYMENT_HASH,
          providerPaymentRef: null,
          invoiceSats: 40_100 as Satoshis,
          expiresAt: at(-1),
        }),
      )
      const res = await runAt(0)
      if (res instanceof Error) throw res
      expect(mockGetTransactionDetails).not.toHaveBeenCalled()
      expect(mockFetchAndSettle).toHaveBeenCalledWith(order)
      expect(res.expired).toBe(0)
      expect(res.paymentSettled).toBe(1)
      expect(res.fulfilled).toBe(1)
      expect(repo.store.get("i")?.status).toBe("FULFILLED")
    })

    it("INVOICE_ISSUED past expiresAt with no ref and nothing at the vendor -> EXPIRED", async () => {
      repo.seed(
        makeOrder({
          id: "i" as GiftCardOrderId,
          status: "INVOICE_ISSUED",
          providerOrderId: "tbc-i" as GiftCardProviderOrderId,
          paymentHash: PAYMENT_HASH,
          providerPaymentRef: null,
          expiresAt: at(-1),
        }),
      )
      const res = await runAt(0)
      if (res instanceof Error) throw res
      expect(mockFetchAndSettle).toHaveBeenCalledTimes(1)
      expect(res.expired).toBe(1)
      expect(repo.store.get("i")?.status).toBe("EXPIRED")
    })

    it.each(["failed", "refunded"] as const)(
      "INVOICE_ISSUED past expiresAt that the vendor reports %s -> FAILED via the vendor, not EXPIRED",
      async (kind) => {
        // The vendor's answer is handed to `settleOrderFromVendor`, which
        // decides (INVOICE_ISSUED + vendor failed → FAILED, nothing was paid).
        mockFetchVendorStatus.mockResolvedValue({ kind, reason: "cancelled" })
        mockSettleFromVendor.mockImplementation(async (o: GiftCardOrder) => {
          const failed = {
            ...o,
            status: "FAILED" as const,
            failureReason: `vendor-${kind}`,
          }
          repo.store.set(o.id, failed)
          return failed
        })
        const order = repo.seed(
          makeOrder({
            id: "i" as GiftCardOrderId,
            status: "INVOICE_ISSUED",
            providerOrderId: "tbc-i" as GiftCardProviderOrderId,
            expiresAt: at(-1),
          }),
        )
        const res = await runAt(0)
        if (res instanceof Error) throw res
        expect(mockSettleFromVendor).toHaveBeenCalledWith(order, {
          kind,
          reason: "cancelled",
        })
        expect(res.expired).toBe(0)
        expect(repo.store.get("i")?.status).toBe("FAILED")
        expect(repo.transition).not.toHaveBeenCalled()
      },
    )

    it("INVOICE_ISSUED past expiresAt with the vendor unreachable is expired (the vendor could not vouch for it)", async () => {
      mockFetchVendorStatus.mockResolvedValue(new GiftCardVendorUnavailableError())
      repo.seed(
        makeOrder({
          id: "i" as GiftCardOrderId,
          status: "INVOICE_ISSUED",
          providerOrderId: "tbc-i" as GiftCardProviderOrderId,
          expiresAt: at(-1),
        }),
      )
      const res = await runAt(0)
      if (res instanceof Error) throw res
      expect(mockSettleFromVendor).not.toHaveBeenCalled()
      expect(res.expired).toBe(1)
    })

    it("EXPIRED orders are never listed or polled: their one exit is the purchase path's", async () => {
      repo.seed(
        makeOrder({
          id: "x" as GiftCardOrderId,
          status: "EXPIRED",
          providerOrderId: "tbc-x" as GiftCardProviderOrderId,
          expiresAt: at(-HOUR),
        }),
      )
      const res = await runAt(0)
      if (res instanceof Error) throw res
      expect(res.scanned).toBe(0)
      expect(mockFetchVendorStatus).not.toHaveBeenCalled()
      expect(mockFetchAndSettle).not.toHaveBeenCalled()
      for (const call of repo.listByStatus.mock.calls) {
        expect(call[0].statuses).not.toContain("EXPIRED")
      }
    })

    it("orders not yet expired are untouched", async () => {
      repo.seed(
        makeOrder({ id: "c" as GiftCardOrderId, status: "CREATED", expiresAt: at(+1) }),
      )
      const res = await runAt(0)
      if (res instanceof Error) throw res
      expect(res.scanned).toBe(0)
      expect(repo.transition).not.toHaveBeenCalled()
    })
  })

  describe("PAYMENT_PENDING", () => {
    const pending = () =>
      repo.seed(
        makeOrder({
          id: "p" as GiftCardOrderId,
          status: "PAYMENT_PENDING",
          paymentHash: PAYMENT_HASH,
          providerPaymentRef: "ibex-tx",
          invoiceSats: 40_100 as Satoshis,
          providerOrderId: "tbc-p" as GiftCardProviderOrderId,
        }),
      )

    it("settled -> PAID and polled immediately", async () => {
      mockGetTransactionDetails.mockResolvedValue(ibexTransaction(2))
      pending()
      const res = await runAt(0)
      if (res instanceof Error) throw res
      expect(res.paymentSettled).toBe(1)
      expect(repo.store.get("p")?.status).toBe("PAID")
      expect(mockFetchAndSettle).toHaveBeenCalledTimes(1)
      expect(mockNotifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({ phase: "order-paid", status: "success" }),
      )
    })

    it("failed -> PAYMENT_FAILED", async () => {
      mockGetTransactionDetails.mockResolvedValue(ibexTransaction(3))
      pending()
      const res = await runAt(0)
      if (res instanceof Error) throw res
      expect(repo.store.get("p")?.status).toBe("PAYMENT_FAILED")
      expect(mockFetchAndSettle).not.toHaveBeenCalled()
    })

    it("in flight at IBEX stays PAYMENT_PENDING and the vendor is not asked", async () => {
      mockGetTransactionDetails.mockResolvedValue(ibexTransaction(1))
      pending()
      const res = await runAt(0)
      if (res instanceof Error) throw res
      expect(repo.store.get("p")?.status).toBe("PAYMENT_PENDING")
      expect(repo.transition).not.toHaveBeenCalled()
      expect(mockFetchAndSettle).not.toHaveBeenCalled()
    })

    it("unknown at IBEX asks the vendor and stays PAYMENT_PENDING when it has nothing new", async () => {
      pending()
      const res = await runAt(0)
      if (res instanceof Error) throw res
      expect(mockFetchAndSettle).toHaveBeenCalledTimes(1)
      expect(repo.store.get("p")?.status).toBe("PAYMENT_PENDING")
      expect(repo.transition).not.toHaveBeenCalled()
    })

    describe("no IBEX transaction id (send errored before IBEX answered, or crashed before the ref was written)", () => {
      const noRef = () =>
        repo.seed(
          makeOrder({
            id: "noref" as GiftCardOrderId,
            status: "PAYMENT_PENDING",
            providerOrderId: "tbc-noref" as GiftCardProviderOrderId,
            paymentRequest: "lnbc1...",
            paymentHash: PAYMENT_HASH,
            providerPaymentRef: null,
            invoiceSats: 40_100 as Satoshis,
          }),
        )

      it("asks the vendor instead of IBEX", async () => {
        const order = noRef()
        const res = await runAt(0)
        if (res instanceof Error) throw res
        expect(mockGetTransactionDetails).not.toHaveBeenCalled()
        expect(mockFetchAndSettle).toHaveBeenCalledWith(order)
        expect(repo.store.get("noref")?.status).toBe("PAYMENT_PENDING")
      })

      it("vendor says fulfilled -> PAID -> FULFILLED, counted as settled and fulfilled", async () => {
        vendorFulfils()
        noRef()
        const res = await runAt(0)
        if (res instanceof Error) throw res
        expect(res.paymentSettled).toBe(1)
        expect(res.fulfilled).toBe(1)
        expect(repo.store.get("noref")?.status).toBe("FULFILLED")
      })

      it("a vendor error leaves the order pending for the next run", async () => {
        mockFetchVendorStatus.mockResolvedValue(new GiftCardVendorUnavailableError())
        noRef()
        const res = await runAt(0)
        if (res instanceof Error) throw res
        expect(repo.store.get("noref")?.status).toBe("PAYMENT_PENDING")
        expect(mockSettleFromVendor).not.toHaveBeenCalled()
        expect(mockLogger.error).not.toHaveBeenCalled()
      })

      it.each(["failed", "refunded"] as const)(
        "vendor says %s: left for the payment re-read, never PAYMENT_FAILED on the vendor's word",
        async (kind) => {
          // `settleOrderFromVendor` leaves a PAYMENT_PENDING order alone on
          // failed/refunded (our send may still be in flight); the unresolved
          // exit below needs the vendor's positive "awaiting payment", which
          // this is not — even long past the grace period.
          mockFetchVendorStatus.mockResolvedValue({ kind, reason: "cancelled" })
          mockSettleFromVendor.mockImplementation(async (o: GiftCardOrder) => o)
          const order = noRef()
          const res = await runAt(GIFT_CARD_PAYMENT_UNRESOLVED_GRACE_MS + 2 * HOUR)
          if (res instanceof Error) throw res
          expect(mockSettleFromVendor).toHaveBeenCalledWith(order, {
            kind,
            reason: "cancelled",
          })
          expect(repo.store.get("noref")?.status).toBe("PAYMENT_PENDING")
          expect(repo.transition).not.toHaveBeenCalled()
        },
      )

      describe("unresolved: vendor never saw a payment and the invoice is long expired", () => {
        // No ref means IBEX never handed back an id, so only the vendor can
        // ever resolve this row. Once the invoice has been expired a full day
        // and the vendor still says unpaid, no send can settle it: the money
        // did not leave. This is the only terminal exit for a ref-less
        // PAYMENT_PENDING, which otherwise pins the front of listByStatus.
        const awaitingPayment = () =>
          mockFetchVendorStatus.mockResolvedValue({ kind: "awaitingPayment" })
        const pastGrace = GIFT_CARD_PAYMENT_UNRESOLVED_GRACE_MS + 15 * MINUTE + 1

        it("-> PAYMENT_FAILED with reason payment-unresolved-expired, and an ops event", async () => {
          awaitingPayment()
          noRef() // expiresAt = NOW + 15m
          const res = await runAt(pastGrace)
          if (res instanceof Error) throw res
          const after = repo.store.get("noref")
          expect(after?.status).toBe("PAYMENT_FAILED")
          expect(after?.failureReason).toBe("payment-unresolved-expired")
          expect(after?.statusHistory.at(-1)?.reason).toBe("payment-unresolved-expired")
          expect(mockNotifyOpsEvent).toHaveBeenCalledWith(
            expect.objectContaining({
              flow: "giftcard",
              phase: "order-failed",
              status: "failed",
              meta: expect.objectContaining({
                orderId: "noref",
                reason: "payment-unresolved-expired",
                vendorStatus: "awaitingPayment",
              }),
            }),
          )
        })

        it("not before expiresAt + 24h: stays PAYMENT_PENDING", async () => {
          awaitingPayment()
          noRef()
          const res = await runAt(
            GIFT_CARD_PAYMENT_UNRESOLVED_GRACE_MS + 15 * MINUTE - SECOND,
          )
          if (res instanceof Error) throw res
          expect(repo.store.get("noref")?.status).toBe("PAYMENT_PENDING")
          expect(repo.transition).not.toHaveBeenCalled()
        })

        it("not when the vendor says paid-pending-fulfillment: a card may still come", async () => {
          mockFetchVendorStatus.mockResolvedValue({ kind: "paidPendingFulfillment" })
          noRef()
          const res = await runAt(pastGrace)
          if (res instanceof Error) throw res
          expect(repo.store.get("noref")?.status).toBe("PAYMENT_PENDING")
          expect(repo.transition).not.toHaveBeenCalled()
        })

        it("not when the order HAS an IBEX ref: IBEX, not the vendor, owns that answer", async () => {
          awaitingPayment()
          repo.seed(
            makeOrder({
              id: "ref" as GiftCardOrderId,
              status: "PAYMENT_PENDING",
              providerOrderId: "tbc-ref" as GiftCardProviderOrderId,
              providerPaymentRef: "ibex-tx",
            }),
          )
          const res = await runAt(pastGrace)
          if (res instanceof Error) throw res
          expect(repo.store.get("ref")?.status).toBe("PAYMENT_PENDING")
          expect(repo.transition).not.toHaveBeenCalled()
        })

        it("not when the vendor could not be asked", async () => {
          mockFetchVendorStatus.mockResolvedValue(new GiftCardVendorUnavailableError())
          noRef()
          const res = await runAt(pastGrace)
          if (res instanceof Error) throw res
          expect(repo.store.get("noref")?.status).toBe("PAYMENT_PENDING")
        })
      })
    })

    it("a poll that leaves the status unchanged bumps updatedAt so the batch rotates", async () => {
      // listByStatus is oldest-updatedAt first; a stuck row that is never
      // touched would sit at the front of every run.
      const order = pending()
      await runAt(5 * SECOND)
      expect(repo.touch).toHaveBeenCalledWith("p")
      expect(repo.store.get("p")?.updatedAt.getTime()).toBe(NOW_MS + 5 * SECOND)
      expect(repo.store.get("p")?.updatedAt.getTime()).toBeGreaterThan(
        order.updatedAt.getTime(),
      )
      expect(repo.store.get("p")?.status).toBe("PAYMENT_PENDING")
      expect(repo.store.get("p")?.statusHistory).toEqual(order.statusHistory)
    })

    it("a poll that moves the order does not touch it: the transition already moved updatedAt", async () => {
      mockGetTransactionDetails.mockResolvedValue(ibexTransaction(3))
      pending()
      await runAt(0)
      expect(repo.touch).not.toHaveBeenCalled()
    })

    it("a touch failure is logged and does not fail the order", async () => {
      repo.touch.mockResolvedValueOnce(
        new (jest.requireActual("@domain/errors").RepositoryError)("mongo"),
      )
      pending()
      const res = await runAt(0)
      if (res instanceof Error) throw res
      expect(mockLogger.error).not.toHaveBeenCalled()
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: "p" }),
        expect.stringContaining("updatedAt"),
      )
    })

    it("an IBEX lookup error falls back to the vendor and leaves the order pending", async () => {
      mockGetTransactionDetails.mockResolvedValue(new IbexError(new Error("502")))
      pending()
      const res = await runAt(0)
      if (res instanceof Error) throw res
      expect(repo.store.get("p")?.status).toBe("PAYMENT_PENDING")
      expect(repo.transition).not.toHaveBeenCalled()
      expect(mockFetchAndSettle).toHaveBeenCalledTimes(1)
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: "p", providerPaymentRef: "ibex-tx" }),
        expect.stringContaining("Could not re-read"),
      )
    })

    it("a transaction with no recognised payment status is not treated as in flight", async () => {
      mockGetTransactionDetails.mockResolvedValue(ibexTransaction(0))
      pending()
      const res = await runAt(0)
      if (res instanceof Error) throw res
      expect(repo.store.get("p")?.status).toBe("PAYMENT_PENDING")
      expect(repo.transition).not.toHaveBeenCalled()
      expect(mockFetchAndSettle).toHaveBeenCalledTimes(1)
    })

    it("warns once pending for over an hour", async () => {
      pending()
      await runAt(61 * MINUTE)
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: "p" }),
        expect.stringContaining("pending for over an hour"),
      )
    })
  })

  describe("PAID backoff", () => {
    it("polls on the 5s/15s/60s/5m/15m schedule and not in between", async () => {
      paidOrder("a", 0)
      const pollsAfter = async (offset: number) => {
        mockFetchAndSettle.mockClear()
        await runAt(offset)
        return mockFetchAndSettle.mock.calls.length
      }
      expect(await pollsAfter(1 * SECOND)).toBe(0)
      expect(await pollsAfter(5 * SECOND)).toBe(1)
      expect(await pollsAfter(10 * SECOND)).toBe(0)
      expect(await pollsAfter(20 * SECOND)).toBe(1)
      expect(await pollsAfter(30 * SECOND)).toBe(0)
      expect(await pollsAfter(80 * SECOND)).toBe(1)
      expect(await pollsAfter(3 * MINUTE)).toBe(0)
      expect(await pollsAfter(380 * SECOND)).toBe(1)
      expect(await pollsAfter(380 * SECOND + 10 * MINUTE)).toBe(0)
      expect(await pollsAfter(380 * SECOND + 15 * MINUTE)).toBe(1)
      expect(await pollsAfter(380 * SECOND + 29 * MINUTE)).toBe(0)
      expect(await pollsAfter(380 * SECOND + 30 * MINUTE)).toBe(1)
    })

    it("a fresh process polls a long-PAID order at most once per 15 minutes", async () => {
      paidOrder("a", -2 * HOUR)
      await runAt(0)
      expect(mockFetchAndSettle).toHaveBeenCalledTimes(1)
      await runAt(10 * MINUTE)
      expect(mockFetchAndSettle).toHaveBeenCalledTimes(1)
      await runAt(15 * MINUTE)
      expect(mockFetchAndSettle).toHaveBeenCalledTimes(2)
    })

    it("counts a fulfilment and stops tracking the order", async () => {
      const order = paidOrder("a", -10 * SECOND)
      mockFetchAndSettle.mockImplementation(async (o: GiftCardOrder) => {
        const fulfilled = { ...o, status: "FULFILLED" as const }
        repo.store.set(o.id, fulfilled)
        return fulfilled
      })
      const res = await runAt(0)
      if (res instanceof Error) throw res
      expect(res.fulfilled).toBe(1)
      expect(res.scanned).toBe(1)
      expect(mockFetchAndSettle).toHaveBeenCalledWith(order)
    })

    it("counts a vendor refund", async () => {
      paidOrder("a", -10 * SECOND)
      mockFetchAndSettle.mockImplementation(async (o: GiftCardOrder) => ({
        ...o,
        status: "REFUND_REQUIRED" as const,
      }))
      const res = await runAt(0)
      if (res instanceof Error) throw res
      expect(res.refundRequired).toBe(1)
    })

    it("a poll that leaves the order PAID bumps updatedAt; one that moves it does not", async () => {
      const order = paidOrder("a", -10 * SECOND)
      await runAt(0)
      expect(repo.touch).toHaveBeenCalledWith("a")
      expect(repo.store.get("a")?.updatedAt.getTime()).toBeGreaterThan(
        order.updatedAt.getTime(),
      )

      repo.touch.mockClear()
      mockFetchAndSettle.mockImplementation(async (o: GiftCardOrder) => {
        const fulfilled = { ...o, status: "FULFILLED" as const }
        repo.store.set(o.id, fulfilled)
        return fulfilled
      })
      await runAt(20 * SECOND)
      expect(repo.touch).not.toHaveBeenCalled()
    })
  })

  describe("24h escalation", () => {
    it("PAID for 24h with the vendor positively reporting no card -> REFUND_REQUIRED with reason fulfillment-timeout, and pages", async () => {
      const order = paidOrder("old", -GIFT_CARD_PAID_TIMEOUT_MS)
      const res = await runAt(0)
      if (res instanceof Error) throw res
      expect(res.refundRequired).toBe(1)
      const after = repo.store.get("old")
      expect(after?.status).toBe("REFUND_REQUIRED")
      expect(after?.failureReason).toBe("fulfillment-timeout")
      // One final vendor poll precedes the escalation.
      expect(mockFetchAndSettle).toHaveBeenCalledTimes(1)
      expect(mockFetchAndSettle).toHaveBeenCalledWith(order)
      expect(mockNotifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          flow: "giftcard",
          phase: "refund-required",
          status: "failed",
          error: "fulfillment-timeout",
          meta: expect.objectContaining({
            orderId: "old",
            lastVendorPoll: "not-fulfilled",
          }),
        }),
      )
    })

    it("PAID for 25h with the vendor returning fulfilled ends FULFILLED, not REFUND_REQUIRED", async () => {
      // A worker gap over 24h (outage, stuck lock) must not refund orders the
      // vendor fulfilled in the meantime.
      vendorFulfils()
      paidOrder("old", -(GIFT_CARD_PAID_TIMEOUT_MS + HOUR))
      const res = await runAt(0)
      if (res instanceof Error) throw res
      expect(res.refundRequired).toBe(0)
      expect(res.fulfilled).toBe(1)
      expect(repo.store.get("old")?.status).toBe("FULFILLED")
      expect(mockNotifyOpsEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ phase: "refund-required" }),
      )
    })

    it("PAID for 25h with the vendor reporting a refund is REFUND_REQUIRED via the vendor, once", async () => {
      mockFetchAndSettle.mockImplementation(async (o: GiftCardOrder) => {
        const refund = {
          ...o,
          status: "REFUND_REQUIRED" as const,
          failureReason: "vendor-refunded: Refunded",
        }
        repo.store.set(o.id, refund)
        return refund
      })
      paidOrder("old", -(GIFT_CARD_PAID_TIMEOUT_MS + HOUR))
      const res = await runAt(0)
      if (res instanceof Error) throw res
      expect(res.refundRequired).toBe(1)
      expect(repo.store.get("old")?.failureReason).toBe("vendor-refunded: Refunded")
      expect(repo.transition).not.toHaveBeenCalled()
    })

    describe("an error on the final poll says nothing about the card: stay PAID, retry next run", () => {
      // REFUND_REQUIRED means "money left and no card is coming". A vendor 5xx,
      // a claim-key fault (the card IS issued; only our storage failed) or a
      // repository error cannot establish that, and escalating on one would
      // refund a delivered card.
      it.each([
        ["a vendor 5xx", () => new GiftCardVendorUnavailableError()],
        ["a claim-key fault", () => new GiftCardClaimCryptoError("no key")],
        [
          "a repository fault",
          () =>
            new (jest.requireActual("@domain/errors").UnknownRepositoryError)("mongo"),
        ],
      ])(
        "%s at 24h keeps the order PAID, counted and logged at warn",
        async (_label, make) => {
          const error = make()
          mockFetchAndSettle.mockResolvedValue(error)
          paidOrder("old", -GIFT_CARD_PAID_TIMEOUT_MS)
          const res = await runAt(0)
          if (res instanceof Error) throw res
          expect(res.refundRequired).toBe(0)
          expect(res.finalPollFailed).toBe(1)
          expect(repo.store.get("old")?.status).toBe("PAID")
          expect(repo.transition).not.toHaveBeenCalled()
          expect(mockNotifyOpsEvent).not.toHaveBeenCalledWith(
            expect.objectContaining({ phase: "refund-required" }),
          )
          expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ orderId: "old", error: error.constructor.name }),
            expect.stringContaining("keeping PAID"),
          )
          expect(mockLogger.error).not.toHaveBeenCalled()
          // ...and the row is touched so it does not pin the front of the batch.
          expect(repo.touch).toHaveBeenCalledWith("old")
        },
      )

      it("retries on the next run and escalates once the vendor answers 'still PAID'", async () => {
        mockFetchAndSettle.mockResolvedValueOnce(new GiftCardVendorUnavailableError())
        paidOrder("old", -GIFT_CARD_PAID_TIMEOUT_MS)
        const first = await runAt(0)
        if (first instanceof Error) throw first
        expect(repo.store.get("old")?.status).toBe("PAID")

        const second = await runAt(15 * MINUTE)
        if (second instanceof Error) throw second
        expect(second.refundRequired).toBe(1)
        expect(repo.store.get("old")?.status).toBe("REFUND_REQUIRED")
      })
    })

    it("one second short of 24h still polls", async () => {
      paidOrder("almost", -(GIFT_CARD_PAID_TIMEOUT_MS - SECOND))
      const res = await runAt(0)
      if (res instanceof Error) throw res
      expect(res.refundRequired).toBe(0)
      expect(mockFetchAndSettle).toHaveBeenCalledTimes(1)
    })
  })

  describe("isolation", () => {
    it("one order throwing does not stop the others", async () => {
      paidOrder("bad", -10 * SECOND)
      paidOrder("good", -10 * SECOND)
      mockFetchAndSettle.mockImplementation(async (o: GiftCardOrder) => {
        if (o.id === "bad") throw new Error("vendor exploded")
        const fulfilled = { ...o, status: "FULFILLED" as const }
        repo.store.set(o.id, fulfilled)
        return fulfilled
      })
      const res = await runAt(0)
      if (res instanceof Error) throw res
      expect(res.scanned).toBe(2)
      expect(res.fulfilled).toBe(1)
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: "bad" }),
        expect.any(String),
      )
      expect(mockRedisDel).toHaveBeenCalledTimes(1)
    })

    it("a returned vendor error is logged and counted as scanned", async () => {
      paidOrder("a", -10 * SECOND)
      mockFetchAndSettle.mockResolvedValue(new GiftCardVendorUnavailableError())
      const res = await runAt(0)
      if (res instanceof Error) throw res
      expect(res.scanned).toBe(1)
      expect(res.fulfilled).toBe(0)
      expect(mockLogger.error).toHaveBeenCalled()
    })

    it("a listing failure for one status does not skip the others", async () => {
      repo.listByStatus.mockImplementation(
        async ({ statuses }: { statuses: string[] }) => {
          if (statuses.includes("PAYMENT_PENDING")) {
            return new (jest.requireActual("@domain/errors").RepositoryError)("mongo")
          }
          return [...repo.store.values()].filter((o) => statuses.includes(o.status))
        },
      )
      paidOrder("a", -10 * SECOND)
      const res = await runAt(0)
      if (res instanceof Error) throw res
      expect(res.scanned).toBe(1)
      expect(mockFetchAndSettle).toHaveBeenCalledTimes(1)
    })
  })
})

describe("hasOpenGiftCardOrders", () => {
  it("asks for one non-terminal order", async () => {
    await hasOpenGiftCardOrders()
    expect(repo.listByStatus).toHaveBeenCalledWith({
      statuses: ["CREATED", "INVOICE_ISSUED", "PAYMENT_PENDING", "PAID"],
      limit: 1,
    })
    expect(GIFT_CARD_OPEN_STATUSES).toEqual([
      "CREATED",
      "INVOICE_ISSUED",
      "PAYMENT_PENDING",
      "PAID",
    ])
  })

  it("is false with only terminal orders, true with any open one", async () => {
    repo.seed(makeOrder({ id: "done" as GiftCardOrderId, status: "FULFILLED" }))
    repo.seed(makeOrder({ id: "refund" as GiftCardOrderId, status: "REFUND_REQUIRED" }))
    expect(await hasOpenGiftCardOrders()).toBe(false)
    paidOrder("a", -10 * SECOND)
    expect(await hasOpenGiftCardOrders()).toBe(true)
  })

  it("fails open on a repository fault so the run itself logs it", async () => {
    repo.listByStatus.mockResolvedValueOnce(
      new (jest.requireActual("@domain/errors").RepositoryError)("mongo"),
    )
    expect(await hasOpenGiftCardOrders()).toBe(true)
  })
})

describe("reconcileGiftCardOrdersJob", () => {
  it("keeps running while gift cards are disabled: the kill switch stops new money, not settlement", async () => {
    mockConfig = makeGiftCardsConfig({ enabled: false })
    vendorFulfils()
    paidOrder("a", -10 * SECOND)
    await reconcileGiftCardOrdersJob()
    expect(mockRedisSet).toHaveBeenCalledTimes(1)
    expect(mockFetchAndSettle).toHaveBeenCalledTimes(1)
    expect(repo.store.get("a")?.status).toBe("FULFILLED")
  })

  it("still escalates the 24h timeout while gift cards are disabled", async () => {
    mockConfig = makeGiftCardsConfig({ enabled: false })
    paidOrder("old", -GIFT_CARD_PAID_TIMEOUT_MS)
    await reconcileGiftCardOrdersJob()
    expect(repo.store.get("old")?.status).toBe("REFUND_REQUIRED")
  })

  it("does not take the lock when no non-terminal order exists", async () => {
    repo.seed(makeOrder({ id: "done" as GiftCardOrderId, status: "FULFILLED" }))
    await reconcileGiftCardOrdersJob()
    expect(repo.listByStatus).toHaveBeenCalledTimes(1)
    expect(mockRedisSet).not.toHaveBeenCalled()
    expect(mockLogger.info).not.toHaveBeenCalled()
  })

  it("throws the reconcile error so the cron runner counts the failure", async () => {
    paidOrder("a", -10 * SECOND)
    mockRedisSet.mockRejectedValue(new Error("ECONNREFUSED"))
    await expect(reconcileGiftCardOrdersJob()).rejects.toBeInstanceOf(
      UnknownGiftCardError,
    )
  })

  it("logs the summary on success", async () => {
    paidOrder("a", -1 * SECOND) // open, but not yet due for a poll
    await reconcileGiftCardOrdersJob()
    expect(mockLogger.info).toHaveBeenCalledWith(
      { summary: expect.objectContaining({ scanned: 1, fulfilled: 0 }) },
      "gift card reconcile finished",
    )
  })
})

describe("startGiftCardReconcileInterval", () => {
  it("ticks while gift cards are disabled when an open order exists", async () => {
    mockConfig = makeGiftCardsConfig({ enabled: false })
    vendorFulfils()
    paidOrder("a", -10 * SECOND)
    const timer = startGiftCardReconcileInterval(1000)
    try {
      await jest.advanceTimersByTimeAsync(1000)
      expect(mockRedisSet).toHaveBeenCalledTimes(1)
      expect(mockFetchAndSettle).toHaveBeenCalledTimes(1)
      expect(repo.store.get("a")?.status).toBe("FULFILLED")
    } finally {
      clearInterval(timer)
    }
  })

  it("skips the lock on a tick with nothing open", async () => {
    repo.seed(makeOrder({ id: "done" as GiftCardOrderId, status: "FULFILLED" }))
    const timer = startGiftCardReconcileInterval(1000)
    try {
      await jest.advanceTimersByTimeAsync(2000)
      expect(repo.listByStatus).toHaveBeenCalledTimes(2)
      expect(mockRedisSet).not.toHaveBeenCalled()
    } finally {
      clearInterval(timer)
    }
  })
})
