import { RepositoryError } from "@domain/errors"
import {
  GiftCardLevelNotEligibleError,
  GiftCardLimitExceededError,
  GiftCardsDisabledError,
  UnknownGiftCardError,
} from "@domain/gift-cards"

import {
  authorizeGiftCardPurchase,
  GiftCardRejectionReasons,
  releaseGiftCardReservation,
} from "@app/gift-cards/authorize-purchase"

import {
  ACCOUNT_ID,
  DAY_MS,
  makeAccount,
  makeGiftCardsConfig,
  makeOrder,
  makeProduct,
  NOW_MS,
} from "./fixtures"

const mockListByAccount = jest.fn()
const mockNotifyOpsEvent = jest.fn()
const mockZadd = jest.fn()
const mockSet = jest.fn()
const mockZremrangebyscore = jest.fn()
const mockZrange = jest.fn()
const mockGet = jest.fn()
const mockZrem = jest.fn()
const mockDel = jest.fn()

let mockConfig = makeGiftCardsConfig()

jest.mock("@config", () => ({
  get GiftCardsConfig() {
    return mockConfig
  },
}))
jest.mock("@services/mongoose", () => ({
  GiftCardOrdersRepository: () => ({
    listByAccount: (...a: unknown[]) => mockListByAccount(...a),
  }),
}))
jest.mock("@services/redis", () => ({
  redis: {
    zadd: (...a: unknown[]) => mockZadd(...a),
    set: (...a: unknown[]) => mockSet(...a),
    zremrangebyscore: (...a: unknown[]) => mockZremrangebyscore(...a),
    zrange: (...a: unknown[]) => mockZrange(...a),
    get: (...a: unknown[]) => mockGet(...a),
    zrem: (...a: unknown[]) => mockZrem(...a),
    del: (...a: unknown[]) => mockDel(...a),
  },
}))
jest.mock("@services/alerts/ops-events", () => ({
  notifyOpsEvent: (...a: unknown[]) => mockNotifyOpsEvent(...a),
}))
jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))
jest.mock("@services/tracing", () => ({
  addAttributesToCurrentSpan: jest.fn(),
  recordExceptionInCurrentSpan: jest.fn(),
}))

const HOUR_MS = 60 * 60 * 1000

const authorize = (overrides: Record<string, unknown> = {}) =>
  authorizeGiftCardPurchase({
    account: makeAccount(),
    product: makeProduct(),
    valueMinor: 2500,
    quantity: 1,
    nowMs: NOW_MS,
    ...overrides,
  } as Parameters<typeof authorizeGiftCardPurchase>[0])

const withMode = (mode: GiftCardLimitsMode) => {
  mockConfig = makeGiftCardsConfig({ limits: { ...makeGiftCardsConfig().limits, mode } })
}

const priorOrder = (
  valueMinor: number,
  ageMs: number,
  status: GiftCardOrderStatus = "FULFILLED",
) =>
  makeOrder({
    id: `prior-${valueMinor}-${ageMs}` as GiftCardOrderId,
    valueMinor,
    status,
    createdAt: new Date(NOW_MS - ageMs),
  })

const reservation = (amountMinor: number, id = "res-open") => [
  `${amountMinor}:${id}`,
  String(NOW_MS + DAY_MS),
]

beforeEach(() => {
  jest.clearAllMocks()
  mockConfig = makeGiftCardsConfig()
  mockListByAccount.mockResolvedValue([])
  mockZadd.mockResolvedValue(1)
  mockSet.mockResolvedValue("OK")
  mockZremrangebyscore.mockResolvedValue(0)
  mockZrange.mockResolvedValue([])
  mockGet.mockResolvedValue(null)
  mockZrem.mockResolvedValue(1)
  mockDel.mockResolvedValue(1)
})

const expectRejected = (
  res: Awaited<ReturnType<typeof authorizeGiftCardPurchase>>,
  reason: string,
  errorClass: new (...args: never[]) => Error,
) => {
  expect(res.authorized).toBe(false)
  if (res.authorized) return
  expect(res.reason).toBe(reason)
  expect(res.error).toBeInstanceOf(errorClass)
}

describe("authorizeGiftCardPurchase", () => {
  describe("levels x amounts x modes", () => {
    const cases: Array<{
      level: number
      valueMinor: number
      quantity?: number
      expected: "ok" | string
    }> = [
      { level: 0, valueMinor: 500, expected: GiftCardRejectionReasons.levelNotEligible },
      { level: 1, valueMinor: 2500, expected: "ok" },
      { level: 1, valueMinor: 20_000, expected: "ok" },
      { level: 1, valueMinor: 20_001, expected: GiftCardRejectionReasons.perCardCap },
      // quantity multiplies into the per-order total
      {
        level: 1,
        valueMinor: 10_000,
        quantity: 3,
        expected: GiftCardRejectionReasons.perCardCap,
      },
      { level: 2, valueMinor: 50_000, expected: "ok" },
      { level: 2, valueMinor: 150_000, expected: GiftCardRejectionReasons.perCardCap },
      { level: 3, valueMinor: 200_000, expected: "ok" },
      { level: 3, valueMinor: 250_000, expected: GiftCardRejectionReasons.perCardCap },
    ]

    for (const mode of ["enforce", "log-only"] as const) {
      for (const c of cases) {
        it(`${mode}: level ${c.level} buying ${c.valueMinor} x${c.quantity ?? 1} -> ${c.expected}`, async () => {
          withMode(mode)
          const product = makeProduct({ maxValue: null })
          const res = await authorize({
            account: makeAccount({ level: c.level }),
            product,
            valueMinor: c.valueMinor,
            quantity: c.quantity ?? 1,
          })

          const wouldReject = c.expected !== "ok"
          const rejected = wouldReject && mode === "enforce"

          expect(res.authorized).toBe(!rejected)
          expect(res.authorized ? null : res.reason).toBe(rejected ? c.expected : null)
          // Only an enforced rejection skips the hold: log-only still consumes
          // the allowance for the order it is about to let through.
          expect(mockZadd).toHaveBeenCalledTimes(rejected ? 0 : 1)
          expect(mockNotifyOpsEvent).toHaveBeenCalledTimes(wouldReject ? 1 : 0)
          const reported = mockNotifyOpsEvent.mock.calls[0]?.[0]
          expect(reported?.flow ?? null).toBe(wouldReject ? "giftcard" : null)
          expect(reported?.phase ?? null).toBe(
            wouldReject ? (mode === "enforce" ? "rejected" : "would-reject") : null,
          )
          expect(reported?.meta?.reason ?? null).toBe(wouldReject ? c.expected : null)
        })
      }
    }

    it("off: authorises without evaluating anything", async () => {
      withMode("off")
      const res = await authorize({
        account: makeAccount({ level: 0 }),
        valueMinor: 9_999_999,
      })
      expect(res).toEqual({ authorized: true, reservationId: null })
      expect(mockListByAccount).not.toHaveBeenCalled()
      expect(mockZadd).not.toHaveBeenCalled()
      expect(mockNotifyOpsEvent).not.toHaveBeenCalled()
    })

    it("level 0 is rejected with the level error even when minAccountLevel is 0", async () => {
      mockConfig = makeGiftCardsConfig({
        limits: { ...makeGiftCardsConfig().limits, minAccountLevel: 0 },
      })
      const res = await authorize({ account: makeAccount({ level: 0 }) })
      expectRejected(
        res,
        GiftCardRejectionReasons.levelNotEligible,
        GiftCardLevelNotEligibleError,
      )
    })

    it("an undefined level is level 0", async () => {
      const res = await authorize({ account: makeAccount({ level: undefined }) })
      expectRejected(
        res,
        GiftCardRejectionReasons.levelNotEligible,
        GiftCardLevelNotEligibleError,
      )
    })

    it("the vendor per-card cap applies when it is tighter than the level cap", async () => {
      const base = makeGiftCardsConfig()
      mockConfig = makeGiftCardsConfig({
        limits: {
          ...base.limits,
          perLevel: {
            ...base.limits.perLevel,
            level3: { perCardCents: 500_000, dailyCents: 5_000_000 },
          },
        },
      })
      const res = await authorize({
        account: makeAccount({ level: 3 }),
        product: makeProduct({ maxValue: null }),
        valueMinor: 250_000,
      })
      expectRejected(
        res,
        GiftCardRejectionReasons.vendorCardCap,
        GiftCardLimitExceededError,
      )
    })
  })

  describe("account age", () => {
    it("rejects an account younger than minAccountAgeHours", async () => {
      const res = await authorize({
        account: makeAccount({ createdAt: new Date(NOW_MS - 23 * HOUR_MS) }),
      })
      expectRejected(
        res,
        GiftCardRejectionReasons.accountTooNew,
        GiftCardLimitExceededError,
      )
    })

    it("allows an account exactly minAccountAgeHours old", async () => {
      const res = await authorize({
        account: makeAccount({ createdAt: new Date(NOW_MS - 24 * HOUR_MS) }),
      })
      expect(res.authorized).toBe(true)
    })
  })

  describe("open-loop cards", () => {
    it("refuses when allowOpenLoop is off, regardless of level", async () => {
      mockConfig = makeGiftCardsConfig({ allowOpenLoop: false })
      const res = await authorize({
        account: makeAccount({ level: 3 }),
        product: makeProduct({ isOpenLoop: true }),
      })
      expectRejected(
        res,
        GiftCardRejectionReasons.openLoopNotAllowed,
        GiftCardsDisabledError,
      )
    })

    it("refuses level 1 even when allowOpenLoop is on", async () => {
      const res = await authorize({
        account: makeAccount({ level: 1 }),
        product: makeProduct({ isOpenLoop: true }),
      })
      expectRejected(
        res,
        GiftCardRejectionReasons.openLoopNotAllowed,
        GiftCardLevelNotEligibleError,
      )
    })

    it("allows level 2 when allowOpenLoop is on", async () => {
      const res = await authorize({
        account: makeAccount({ level: 2 }),
        product: makeProduct({ isOpenLoop: true }),
      })
      expect(res.authorized).toBe(true)
    })

    it("applies the tighter open-loop vendor card cap", async () => {
      const res = await authorize({
        account: makeAccount({ level: 3 }),
        product: makeProduct({ isOpenLoop: true, maxValue: null }),
        valueMinor: 150_000, // < level3 perCard 200_000, > open-loop vendor cap 100_000
      })
      expectRejected(
        res,
        GiftCardRejectionReasons.vendorCardCap,
        GiftCardLimitExceededError,
      )
    })
  })

  describe("velocity", () => {
    it("rejects the Nth order in an hour once maxOrdersPerHour is reached", async () => {
      mockListByAccount.mockResolvedValue([
        priorOrder(500, 5 * 60 * 1000),
        priorOrder(500, 10 * 60 * 1000, "FAILED"), // attempts count, even failed ones
        priorOrder(500, 20 * 60 * 1000),
        priorOrder(500, 30 * 60 * 1000),
        priorOrder(500, 59 * 60 * 1000),
      ])
      const res = await authorize()
      expectRejected(res, GiftCardRejectionReasons.velocity, GiftCardLimitExceededError)
    })

    it("orders older than an hour do not count", async () => {
      mockListByAccount.mockResolvedValue([
        priorOrder(500, 5 * 60 * 1000),
        priorOrder(500, 10 * 60 * 1000),
        priorOrder(500, 20 * 60 * 1000),
        priorOrder(500, 30 * 60 * 1000),
        priorOrder(500, 61 * 60 * 1000),
      ])
      const res = await authorize()
      expect(res.authorized).toBe(true)
    })
  })

  describe("daily cap", () => {
    it("sums the trailing 24h of non-failed orders", async () => {
      mockListByAccount.mockResolvedValue([
        priorOrder(20_000, 2 * HOUR_MS),
        priorOrder(20_000, 20 * HOUR_MS, "PAID"),
      ])
      // 40_000 spent + 15_000 new > level1 daily 50_000
      const res = await authorize({ valueMinor: 15_000 })
      expectRejected(res, GiftCardRejectionReasons.dailyCap, GiftCardLimitExceededError)
    })

    it("ignores FAILED, PAYMENT_FAILED and EXPIRED orders", async () => {
      mockListByAccount.mockResolvedValue([
        priorOrder(20_000, 2 * HOUR_MS, "FAILED"),
        priorOrder(20_000, 3 * HOUR_MS, "PAYMENT_FAILED"),
        priorOrder(20_000, 4 * HOUR_MS, "EXPIRED"),
      ])
      const res = await authorize({ valueMinor: 15_000 })
      expect(res.authorized).toBe(true)
    })

    it("ignores orders older than 24h", async () => {
      mockListByAccount.mockResolvedValue([priorOrder(40_000, 25 * HOUR_MS)])
      const res = await authorize({ valueMinor: 15_000 })
      expect(res.authorized).toBe(true)
    })

    it("counts REFUND_REQUIRED orders: the money left", async () => {
      mockListByAccount.mockResolvedValue([
        priorOrder(40_000, 2 * HOUR_MS, "REFUND_REQUIRED"),
      ])
      const res = await authorize({ valueMinor: 15_000 })
      expectRejected(res, GiftCardRejectionReasons.dailyCap, GiftCardLimitExceededError)
    })

    it("counts live Redis reservations from concurrent authorisations", async () => {
      mockListByAccount.mockResolvedValue([priorOrder(30_000, 2 * HOUR_MS)])
      mockZrange.mockResolvedValue(reservation(15_000))
      // 30_000 + 15_000 held + 10_000 new = 55_000 > 50_000
      const res = await authorize({ valueMinor: 10_000 })
      expectRejected(res, GiftCardRejectionReasons.dailyCap, GiftCardLimitExceededError)
      // Expired holds are pruned before the read.
      expect(mockZremrangebyscore).toHaveBeenCalledWith(
        `giftcards:reservations:${ACCOUNT_ID}`,
        "-inf",
        NOW_MS,
      )
    })

    it("applies the vendor daily cap when the level cap is higher", async () => {
      const base = makeGiftCardsConfig()
      mockConfig = makeGiftCardsConfig({
        limits: {
          ...base.limits,
          perLevel: {
            ...base.limits.perLevel,
            level3: { perCardCents: 200_000, dailyCents: 2_000_000 },
          },
        },
      })
      mockListByAccount.mockResolvedValue([priorOrder(990_000, 2 * HOUR_MS)])
      const res = await authorize({
        account: makeAccount({ level: 3 }),
        product: makeProduct({ maxValue: null }),
        valueMinor: 20_000,
      })
      expectRejected(
        res,
        GiftCardRejectionReasons.vendorDailyCap,
        GiftCardLimitExceededError,
      )
    })
  })

  describe("reservations", () => {
    it("writes a 24h hold on pass and returns its id", async () => {
      const res = await authorize({ valueMinor: 2500, quantity: 2 })
      expect(res.authorized).toBe(true)
      if (!res.authorized) return

      const [indexKey, score, member] = mockZadd.mock.calls[0]
      expect(indexKey).toBe(`giftcards:reservations:${ACCOUNT_ID}`)
      expect(score).toBe(NOW_MS + DAY_MS)
      expect(member).toBe(`5000:${res.reservationId}`)

      const [key, value, ex, ttl] = mockSet.mock.calls[0]
      expect(key).toBe(`giftcards:reservation:${ACCOUNT_ID}:${res.reservationId}`)
      expect(value).toBe("5000")
      expect(ex).toBe("EX")
      expect(ttl).toBe(DAY_MS / 1000)
    })

    it("releaseGiftCardReservation removes the hold from both keys", async () => {
      mockGet.mockResolvedValue("5000")
      await releaseGiftCardReservation(ACCOUNT_ID, "res-1")
      expect(mockZrem).toHaveBeenCalledWith(
        `giftcards:reservations:${ACCOUNT_ID}`,
        "5000:res-1",
      )
      expect(mockDel).toHaveBeenCalledWith(`giftcards:reservation:${ACCOUNT_ID}:res-1`)
    })

    it("releasing a null id is a no-op", async () => {
      await releaseGiftCardReservation(ACCOUNT_ID, null)
      expect(mockGet).not.toHaveBeenCalled()
      expect(mockDel).not.toHaveBeenCalled()
    })

    it("release never throws when Redis is down", async () => {
      mockGet.mockRejectedValue(new Error("ECONNREFUSED"))
      await expect(
        releaseGiftCardReservation(ACCOUNT_ID, "res-1"),
      ).resolves.toBeUndefined()
    })
  })

  describe("limits unavailable", () => {
    it("enforce: a repository fault rejects with a critical error", async () => {
      mockListByAccount.mockResolvedValue(new RepositoryError("mongo down"))
      const res = await authorize()
      expectRejected(
        res,
        GiftCardRejectionReasons.limitsUnavailable,
        UnknownGiftCardError,
      )
      expect(mockZadd).not.toHaveBeenCalled()
    })

    it("enforce: a Redis read fault rejects with a critical error", async () => {
      mockZrange.mockRejectedValue(new Error("ECONNREFUSED"))
      const res = await authorize()
      expectRejected(
        res,
        GiftCardRejectionReasons.limitsUnavailable,
        UnknownGiftCardError,
      )
    })

    it("log-only: a repository fault allows and reports would-reject", async () => {
      withMode("log-only")
      mockListByAccount.mockResolvedValue(new RepositoryError("mongo down"))
      const res = await authorize()
      expect(res.authorized).toBe(true)
      expect(mockNotifyOpsEvent).toHaveBeenCalledTimes(1)
      expect(mockNotifyOpsEvent.mock.calls[0][0]).toMatchObject({
        phase: "would-reject",
        status: "pending",
        meta: { reason: GiftCardRejectionReasons.limitsUnavailable },
      })
    })

    it("enforce: a reservation write fault rejects", async () => {
      mockZadd.mockRejectedValue(new Error("ECONNREFUSED"))
      const res = await authorize()
      expectRejected(
        res,
        GiftCardRejectionReasons.limitsUnavailable,
        UnknownGiftCardError,
      )
    })

    it("log-only: a reservation write fault allows with no reservation id", async () => {
      withMode("log-only")
      mockZadd.mockRejectedValue(new Error("ECONNREFUSED"))
      const res = await authorize()
      expect(res).toEqual({ authorized: true, reservationId: null })
    })
  })

  describe("would-reject event", () => {
    it("carries the account, the display amount, the reason and the level", async () => {
      withMode("log-only")
      const res = await authorize({
        account: makeAccount({ level: 1 }),
        product: makeProduct({ maxValue: null }),
        valueMinor: 25_000,
      })
      expect(res.authorized).toBe(true)
      expect(mockNotifyOpsEvent).toHaveBeenCalledWith({
        flow: "giftcard",
        phase: "would-reject",
        status: "pending",
        accountId: ACCOUNT_ID,
        amount: { value: "250.00", currency: "USD" },
        error: "GiftCardLimitExceededError",
        meta: {
          reason: GiftCardRejectionReasons.perCardCap,
          level: "1",
          productId: "bitcoinCompany:amazon-us",
        },
      })
    })

    it("enforce: reports a rejected event with status failed", async () => {
      const res = await authorize({ account: makeAccount({ level: 0 }) })
      expect(res.authorized).toBe(false)
      expect(mockNotifyOpsEvent.mock.calls[0][0]).toMatchObject({
        phase: "rejected",
        status: "failed",
        error: "GiftCardLevelNotEligibleError",
      })
    })
  })
})
