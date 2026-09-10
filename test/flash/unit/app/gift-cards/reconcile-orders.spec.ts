import { GiftCardVendorUnavailableError, UnknownGiftCardError } from "@domain/gift-cards"
import { IbexError } from "@services/ibex/errors"

import {
  __resetGiftCardReconcileStateForTest,
  GIFT_CARD_PAID_TIMEOUT_MS,
  GIFT_CARD_RECONCILE_LOCK_KEY,
  nextGiftCardPollAt,
  reconcileGiftCardOrders,
  reconcileGiftCardOrdersJob,
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

    it("INVOICE_ISSUED past expiresAt with no payment record -> EXPIRED", async () => {
      repo.seed(
        makeOrder({
          id: "i" as GiftCardOrderId,
          status: "INVOICE_ISSUED",
          paymentHash: PAYMENT_HASH,
          providerPaymentRef: "ibex-tx",
          expiresAt: at(-1),
        }),
      )
      const res = await runAt(0)
      if (res instanceof Error) throw res
      expect(res.expired).toBe(1)
      expect(mockGetTransactionDetails).toHaveBeenCalledWith("ibex-tx")
      expect(repo.store.get("i")?.status).toBe("EXPIRED")
    })

    it("INVOICE_ISSUED past expiresAt whose payment actually settled -> PAID, then polled", async () => {
      mockGetTransactionDetails.mockResolvedValue(ibexTransaction(2))
      repo.seed(
        makeOrder({
          id: "i" as GiftCardOrderId,
          status: "INVOICE_ISSUED",
          paymentHash: PAYMENT_HASH,
          providerPaymentRef: "ibex-tx",
          invoiceSats: 40_100 as Satoshis,
          expiresAt: at(-1),
        }),
      )
      const res = await runAt(0)
      if (res instanceof Error) throw res
      expect(res.expired).toBe(0)
      expect(res.paymentSettled).toBe(1)
      expect(repo.store.get("i")?.status).toBe("PAID")
      expect(repo.store.get("i")?.paidSats).toBe(40_100)
      expect(mockFetchAndSettle).toHaveBeenCalledTimes(1)
    })

    it("INVOICE_ISSUED past expiresAt with an in-flight payment is not expired", async () => {
      mockGetTransactionDetails.mockResolvedValue(ibexTransaction(1))
      repo.seed(
        makeOrder({
          id: "i" as GiftCardOrderId,
          status: "INVOICE_ISSUED",
          paymentHash: PAYMENT_HASH,
          providerPaymentRef: "ibex-tx",
          expiresAt: at(-1),
        }),
      )
      const res = await runAt(0)
      if (res instanceof Error) throw res
      expect(res.expired).toBe(0)
      expect(repo.store.get("i")?.status).toBe("INVOICE_ISSUED")
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

    it("pending / unknown stays PAYMENT_PENDING", async () => {
      pending()
      const res = await runAt(0)
      if (res instanceof Error) throw res
      expect(repo.store.get("p")?.status).toBe("PAYMENT_PENDING")
      expect(repo.transition).not.toHaveBeenCalled()
    })

    it("an order with no IBEX transaction id is left alone and IBEX is not asked", async () => {
      repo.seed(
        makeOrder({
          id: "noref" as GiftCardOrderId,
          status: "PAYMENT_PENDING",
          paymentHash: PAYMENT_HASH,
          providerPaymentRef: null,
        }),
      )
      const res = await runAt(0)
      if (res instanceof Error) throw res
      expect(mockGetTransactionDetails).not.toHaveBeenCalled()
      expect(repo.store.get("noref")?.status).toBe("PAYMENT_PENDING")
    })

    it("an IBEX lookup error leaves the order pending for the next run", async () => {
      mockGetTransactionDetails.mockResolvedValue(new IbexError(new Error("502")))
      pending()
      const res = await runAt(0)
      if (res instanceof Error) throw res
      expect(repo.store.get("p")?.status).toBe("PAYMENT_PENDING")
      expect(repo.transition).not.toHaveBeenCalled()
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
  })

  describe("24h escalation", () => {
    it("PAID for 24h -> REFUND_REQUIRED with reason fulfillment-timeout, and pages", async () => {
      paidOrder("old", -GIFT_CARD_PAID_TIMEOUT_MS)
      const res = await runAt(0)
      if (res instanceof Error) throw res
      expect(res.refundRequired).toBe(1)
      const order = repo.store.get("old")
      expect(order?.status).toBe("REFUND_REQUIRED")
      expect(order?.failureReason).toBe("fulfillment-timeout")
      expect(mockFetchAndSettle).not.toHaveBeenCalled()
      expect(mockNotifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          flow: "giftcard",
          phase: "refund-required",
          status: "failed",
          error: "fulfillment-timeout",
          meta: expect.objectContaining({ orderId: "old" }),
        }),
      )
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

describe("reconcileGiftCardOrdersJob", () => {
  it("is a no-op while gift cards are disabled", async () => {
    mockConfig = makeGiftCardsConfig({ enabled: false })
    await reconcileGiftCardOrdersJob()
    expect(mockRedisSet).not.toHaveBeenCalled()
  })

  it("throws the reconcile error so the cron runner counts the failure", async () => {
    mockRedisSet.mockRejectedValue(new Error("ECONNREFUSED"))
    await expect(reconcileGiftCardOrdersJob()).rejects.toBeInstanceOf(
      UnknownGiftCardError,
    )
  })

  it("logs the summary on success", async () => {
    await reconcileGiftCardOrdersJob()
    expect(mockLogger.info).toHaveBeenCalledWith(
      { summary: expect.objectContaining({ scanned: 0 }) },
      "gift card reconcile finished",
    )
  })
})
