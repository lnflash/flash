const mockConsumeLimiter = jest.fn()
jest.mock("@services/rate-limit", () => ({
  consumeLimiter: (args: unknown) => mockConsumeLimiter(args),
}))

const mockUsdFromBtcMidPriceFn = jest.fn()
jest.mock("@app/prices/mid-price", () => ({
  usdFromBtcMidPriceFn: (args: unknown) => mockUsdFromBtcMidPriceFn(args),
}))

const mockNotifyOpsEvent = jest.fn()
jest.mock("@services/alerts/ops-events", () => ({
  notifyOpsEvent: (event: unknown) => mockNotifyOpsEvent(event),
}))

const mockRecordExceptionInCurrentSpan = jest.fn()
jest.mock("@services/tracing", () => ({
  recordExceptionInCurrentSpan: (args: unknown) => mockRecordExceptionInCurrentSpan(args),
  addAttributesToCurrentSpan: jest.fn(),
}))

// The operator switch. Defaults to `enforce` here so the check cases below read
// as the behaviour they describe; the mode cases drive it explicitly.
const mockSendGuardMode = jest.fn<SendGuardMode, []>(() => "enforce")
jest.mock("@config", () => ({
  ...jest.requireActual("@config"),
  getSendGuardMode: () => mockSendGuardMode(),
}))

import { getAccountLimits } from "@config"

import {
  OPS_EVENT_COALESCE_MS,
  SendRejectionReasons,
  authorizeSend,
} from "@app/payments/authorize-send"

import { AccountLevel } from "@domain/accounts"
import {
  IntraledgerLimitsExceededError,
  WithdrawalLimitsExceededError,
} from "@domain/errors"
import {
  InvalidSendAmountError,
  SendLimitsUnavailableError,
} from "@domain/payments/errors"
import { RateLimitConfig } from "@domain/rate-limit"
import {
  PaymentSendRateLimiterExceededError,
  UnknownRateLimitServiceError,
} from "@domain/rate-limit/errors"
import { DealerPriceServiceError } from "@domain/dealer-price"
import { ErrorLevel, WalletCurrency } from "@domain/shared"

const ACCOUNT_ID = "507f1f77bcf86cd799439011" as AccountId
const WALLET_ID = "ea9e6e57-430e-4c87-bd54-4eee0f7869b8" as WalletId

const account = (level: AccountLevel | undefined): Account =>
  ({ id: ACCOUNT_ID, level }) as unknown as Account

const send = (
  overrides: Partial<Parameters<typeof authorizeSend>[0]> = {},
): Promise<true | ApplicationError> =>
  authorizeSend({
    senderAccount: account(AccountLevel.Zero),
    senderWalletId: WALLET_ID,
    amount: { currency: "USD", cents: 100 },
    kind: "intraledger",
    ...overrides,
  })

const lastOpsEvent = () => mockNotifyOpsEvent.mock.calls.at(-1)?.[0]

// Schema defaults (src/config/schema.ts) — the numbers the guard enforces today.
const L0 = getAccountLimits({ level: AccountLevel.Zero })
const L1 = getAccountLimits({ level: AccountLevel.One })
const L2 = getAccountLimits({ level: AccountLevel.Two })
const L3 = getAccountLimits({ level: AccountLevel.Three })

describe("authorizeSend (ENG-573 Phase 0 send guard)", () => {
  // The `limits-unavailable` ops-event ceiling is module state (a per-reason
  // window), so the clock is faked and wound past two full windows between
  // tests: each case starts with no open window and no carried mute count.
  beforeAll(() => jest.useFakeTimers())
  afterAll(() => jest.useRealTimers())

  beforeEach(() => {
    jest.clearAllMocks()
    jest.advanceTimersByTime(2 * OPS_EVENT_COALESCE_MS + 1)
    mockConsumeLimiter.mockResolvedValue(true)
    mockSendGuardMode.mockReturnValue("enforce")
  })

  describe("attempt budget", () => {
    it("consumes the burst bucket then the daily bucket, keyed on the account, and authorises a sane amount", async () => {
      expect(await send()).toBe(true)
      expect(mockConsumeLimiter.mock.calls).toEqual([
        [{ rateLimitConfig: RateLimitConfig.paymentSend, keyToConsume: ACCOUNT_ID }],
        [{ rateLimitConfig: RateLimitConfig.paymentSendDaily, keyToConsume: ACCOUNT_ID }],
      ])
      expect(mockNotifyOpsEvent).not.toHaveBeenCalled()
    })

    it("rejects when the burst bucket is exhausted, without touching the daily bucket", async () => {
      const err = new PaymentSendRateLimiterExceededError()
      mockConsumeLimiter.mockResolvedValueOnce(err)
      expect(await send()).toBe(err)
      expect(mockConsumeLimiter).toHaveBeenCalledTimes(1)
    })

    it("rejects when the daily bucket is exhausted", async () => {
      const err = new PaymentSendRateLimiterExceededError()
      mockConsumeLimiter.mockResolvedValueOnce(true).mockResolvedValueOnce(err)
      expect(await send()).toBe(err)
      expect(mockConsumeLimiter).toHaveBeenCalledTimes(2)
    })

    // Every further attempt from a blocked caller still consumes, still rejects
    // and would still post. The shared ops queue is 50 deep and drops its oldest
    // events on overflow, so one client in a retry loop must not be able to bury
    // the verification / cashout / deposit feed under its own rejections. The
    // limiter's Redis counters are the record for this reason.
    it("posts NO ops event for a rate-limited caller, however many times it retries", async () => {
      mockConsumeLimiter.mockResolvedValue(new PaymentSendRateLimiterExceededError())

      for (let i = 0; i < 25; i++) {
        expect(await send()).toBeInstanceOf(PaymentSendRateLimiterExceededError)
      }

      expect(mockNotifyOpsEvent).not.toHaveBeenCalled()
      expect(mockRecordExceptionInCurrentSpan).not.toHaveBeenCalled()
    })

    // A store fault is not the caller being noisy — it is Redis being down, and
    // when enforcing that stops every send on every rail. It must not reach the
    // user as "too many attempts" on their first send of the day, and it must
    // reach on-call as an exception.
    it("treats a rate-limit store fault as an infrastructure fault, not as a rate limit", async () => {
      const fault = new UnknownRateLimitServiceError("redis down")
      mockConsumeLimiter.mockResolvedValueOnce(fault)

      const result = await send()

      expect(result).toBeInstanceOf(SendLimitsUnavailableError)
      expect(result).not.toBeInstanceOf(PaymentSendRateLimiterExceededError)
      expect((result as Error).message).toContain("redis down")
      expect(lastOpsEvent()).toMatchObject({
        step: SendRejectionReasons.limitsUnavailable,
        error: "SendLimitsUnavailableError",
      })
      expect(mockRecordExceptionInCurrentSpan).toHaveBeenCalledWith(
        expect.objectContaining({ error: result, level: ErrorLevel.Critical }),
      )
    })

    // The ceiling the round-1 fix fitted to `rate-limited` was missing from the
    // one reason that fires on 100% of sends at once. A Redis fault is not one
    // noisy caller: every send in flight reports it in the same instant, into a
    // shared 50-deep FIFO that drops its oldest entries — burying the
    // verification / cashout / deposit feed during exactly the incident the
    // mode switch exists to survive.
    it("posts at most one ops event however many consecutive store faults it sees", async () => {
      mockConsumeLimiter.mockResolvedValue(new UnknownRateLimitServiceError("redis down"))

      for (let i = 0; i < 50; i++) {
        expect(await send()).toBeInstanceOf(SendLimitsUnavailableError)
      }

      expect(mockNotifyOpsEvent).toHaveBeenCalledTimes(1)
      // The span exception is the durable, unthrottled signal — docs/send-guard.md
      // tells ops to alert on it — so the ceiling costs no visibility.
      expect(mockRecordExceptionInCurrentSpan).toHaveBeenCalledTimes(50)
    })

    it("counts the muted events onto the next one that posts, so the feed is not silently lossy", async () => {
      mockConsumeLimiter.mockResolvedValue(new UnknownRateLimitServiceError("redis down"))

      for (let i = 0; i < 12; i++) await send()
      expect(mockNotifyOpsEvent).toHaveBeenCalledTimes(1)
      expect(lastOpsEvent()?.meta).not.toHaveProperty("muted")

      jest.advanceTimersByTime(OPS_EVENT_COALESCE_MS + 1)
      await send()

      expect(mockNotifyOpsEvent).toHaveBeenCalledTimes(2)
      expect(lastOpsEvent()?.meta.muted).toBe("11")
    })

    // A per-account fact the log-only rollout exists to read one by one, and
    // already bounded by the caller's own attempt budget. Coalescing these would
    // hide which account, which level and what amount the cap would have refused.
    it("does not coalesce over-daily-limit events", async () => {
      for (let i = 0; i < 5; i++) {
        await send({ amount: { currency: "USD", cents: L0.intraLedgerLimit + 1 } })
      }

      expect(mockNotifyOpsEvent).toHaveBeenCalledTimes(5)
      expect(lastOpsEvent()?.step).toBe(SendRejectionReasons.overDailyLimit)
    })

    it("charges the budget even for an attempt it then rejects on amount", async () => {
      const result = await send({ amount: { currency: "USD", cents: -1 } })
      expect(result).toBeInstanceOf(InvalidSendAmountError)
      expect(mockConsumeLimiter).toHaveBeenCalledTimes(2)
    })
  })

  describe("amount sanity", () => {
    it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY, -0.01])(
      "rejects USD cents %p",
      async (cents) => {
        const result = await send({ amount: { currency: "USD", cents } })
        expect(result).toBeInstanceOf(InvalidSendAmountError)
        expect(lastOpsEvent()?.step).toBe(SendRejectionReasons.invalidAmount)
      },
    )

    it("accepts fractional USD cents (USDT settles in micros)", async () => {
      expect(await send({ amount: { currency: "USD", cents: 12.5 } })).toBe(true)
    })

    it("accepts bigint USD cents", async () => {
      expect(await send({ amount: { currency: "USD", cents: 250n } })).toBe(true)
    })

    it("accepts numeric-string cents (the FractionalCentAmount scalar type is a branded string)", async () => {
      expect(await send({ amount: { currency: "USD", cents: "12.5" } })).toBe(true)
    })

    it.each(["", "abc", "-3", "0"])("rejects string cents %p", async (cents) => {
      const result = await send({ amount: { currency: "USD", cents } })
      expect(result).toBeInstanceOf(InvalidSendAmountError)
    })

    it.each([0, -1, 1.5])("rejects sats %p", async (sats) => {
      const result = await send({ amount: { currency: "BTC", sats } })
      expect(result).toBeInstanceOf(InvalidSendAmountError)
      expect(mockUsdFromBtcMidPriceFn).not.toHaveBeenCalled()
    })
  })

  describe("daily limit as per-transaction cap", () => {
    it("allows exactly the level-0 intraledger limit and rejects one cent more", async () => {
      expect(
        await send({ amount: { currency: "USD", cents: L0.intraLedgerLimit } }),
      ).toBe(true)

      const result = await send({
        amount: { currency: "USD", cents: L0.intraLedgerLimit + 1 },
      })
      expect(result).toBeInstanceOf(IntraledgerLimitsExceededError)
      expect((result as Error).message).toBe(
        `Cannot transfer more than $${(L0.intraLedgerLimit / 100).toFixed(2)} in 24 hours`,
      )
      expect(lastOpsEvent()).toMatchObject({
        phase: "rejected",
        status: "failed",
        amount: { value: ((L0.intraLedgerLimit + 1) / 100).toFixed(2), currency: "USD" },
        error: "IntraledgerLimitsExceededError",
        step: SendRejectionReasons.overDailyLimit,
        meta: { level: "0", mode: "enforce" },
      })
    })

    // buildEmbed runs every `meta` value through truncateId (12 chars) and
    // leaves `step` alone, so a reason carried in meta reaches the feed as
    // "over-dai…". The reason is the whole point of the event; it goes in step.
    it("carries the reason in `step`, the one embed field that is never truncated", async () => {
      await send({ amount: { currency: "USD", cents: L0.intraLedgerLimit + 1 } })

      const event = lastOpsEvent()
      expect(event.step).toBe("over-daily-limit")
      expect(event.step.length).toBeGreaterThan(12)
      expect(event.meta).not.toHaveProperty("reason")
    })

    it.each(["lightning", "lnurl", "onchain"] as const)(
      "applies the withdrawal limit to %s sends",
      async (kind) => {
        // Level 1 has distinct intraledger ($2,000) and withdrawal ($1,000) limits.
        expect(L1.withdrawalLimit).toBeLessThan(L1.intraLedgerLimit)
        const between = L1.withdrawalLimit + 1

        const result = await send({
          senderAccount: account(AccountLevel.One),
          amount: { currency: "USD", cents: between },
          kind,
        })
        expect(result).toBeInstanceOf(WithdrawalLimitsExceededError)

        expect(
          await send({
            senderAccount: account(AccountLevel.One),
            amount: { currency: "USD", cents: between },
            kind: "intraledger",
          }),
        ).toBe(true)
      },
    )

    it("rejects the 2026-09-03 wall-of-nines ($999,999,999.99) at every level", async () => {
      for (const level of [
        AccountLevel.Zero,
        AccountLevel.One,
        AccountLevel.Two,
        AccountLevel.Three,
      ]) {
        const result = await send({
          senderAccount: account(level),
          amount: { currency: "USD", cents: 99_999_999_999 },
        })
        expect(result).toBeInstanceOf(IntraledgerLimitsExceededError)
      }
      expect(lastOpsEvent()?.amount).toEqual({ value: "999999999.99", currency: "USD" })
    })

    it("enforces the level-3 placeholder (inherits level 2) instead of failing closed", async () => {
      expect(L3.intraLedgerLimit).toBe(L2.intraLedgerLimit)
      expect(
        await send({
          senderAccount: account(AccountLevel.Three),
          amount: { currency: "USD", cents: L3.intraLedgerLimit },
        }),
      ).toBe(true)
      expect(
        await send({
          senderAccount: account(AccountLevel.Three),
          amount: { currency: "USD", cents: L3.intraLedgerLimit + 1 },
        }),
      ).toBeInstanceOf(IntraledgerLimitsExceededError)
    })

    it("treats an account with no level as level 0", async () => {
      expect(
        await send({
          senderAccount: account(undefined),
          amount: { currency: "USD", cents: L0.intraLedgerLimit },
        }),
      ).toBe(true)
      const result = await send({
        senderAccount: account(undefined),
        amount: { currency: "USD", cents: L0.intraLedgerLimit + 1 },
      })
      expect(result).toBeInstanceOf(IntraledgerLimitsExceededError)
      expect(lastOpsEvent()?.meta.level).toBe("0")
    })

    it("fails closed for a level with no configured limit, and alerts", async () => {
      const result = await send({ senderAccount: account(9 as AccountLevel) })
      expect(result).toBeInstanceOf(SendLimitsUnavailableError)
      expect(lastOpsEvent()?.step).toBe(SendRejectionReasons.limitsUnavailable)
      expect(mockRecordExceptionInCurrentSpan).toHaveBeenCalledWith(
        expect.objectContaining({ error: result, level: ErrorLevel.Critical }),
      )
    })
  })

  describe("sats-denominated sends", () => {
    it("converts sats to USD at the mid price and caps on the result", async () => {
      mockUsdFromBtcMidPriceFn.mockResolvedValue({
        amount: BigInt(L0.withdrawalLimit + 1),
        currency: WalletCurrency.Usd,
      })
      const result = await send({
        amount: { currency: "BTC", sats: 21_000 },
        kind: "lightning",
      })
      expect(result).toBeInstanceOf(WithdrawalLimitsExceededError)
      expect(mockUsdFromBtcMidPriceFn).toHaveBeenCalledWith({
        amount: 21_000n,
        currency: WalletCurrency.Btc,
      })
    })

    it("authorises when the converted amount is within the limit", async () => {
      mockUsdFromBtcMidPriceFn.mockResolvedValue({
        amount: BigInt(L0.withdrawalLimit),
        currency: WalletCurrency.Usd,
      })
      expect(
        await send({ amount: { currency: "BTC", sats: 21_000n }, kind: "lightning" }),
      ).toBe(true)
    })

    it("fails closed when no price is available, and alerts", async () => {
      mockUsdFromBtcMidPriceFn.mockResolvedValue(new DealerPriceServiceError("offline"))
      const result = await send({
        amount: { currency: "BTC", sats: 1 },
        kind: "lightning",
      })
      expect(result).toBeInstanceOf(SendLimitsUnavailableError)
      expect(lastOpsEvent()?.step).toBe(SendRejectionReasons.limitsUnavailable)
      // A price-pod outage past the 10-minute cache window rejects every
      // amount-bearing lightning send and every BTC intraledger send. On-call
      // must see "the guard is blocking sends", not a wave of unexplained
      // payment failures.
      expect(mockRecordExceptionInCurrentSpan).toHaveBeenCalledWith(
        expect.objectContaining({ error: result, level: ErrorLevel.Critical }),
      )
    })
  })

  // The operator switch. This is the first Flash-side amount cap that has ever
  // rejected anything and it sits in front of every send on every rail, so it
  // must be flippable without a deploy — and must not go straight to hard
  // enforcement before anyone has measured what it would refuse.
  describe("sendGuard.mode", () => {
    const overLimit = { currency: "USD", cents: L0.intraLedgerLimit + 1 } as const

    it("defaults to log-only, not enforce, when the config is untouched", () => {
      // Not the mocked reader: the real one, against the real schema default.
      const { getSendGuardMode } = jest.requireActual("@config")
      expect(getSendGuardMode()).toBe("log-only")
    })

    describe("off", () => {
      beforeEach(() => mockSendGuardMode.mockReturnValue("off"))

      it("authorises without consuming budget, pricing, or reporting", async () => {
        expect(await send({ amount: overLimit })).toBe(true)
        expect(mockConsumeLimiter).not.toHaveBeenCalled()
        expect(mockNotifyOpsEvent).not.toHaveBeenCalled()
        expect(mockRecordExceptionInCurrentSpan).not.toHaveBeenCalled()
      })

      it("cannot be blocked by a Redis outage or a missing price", async () => {
        mockConsumeLimiter.mockResolvedValue(new UnknownRateLimitServiceError("down"))
        mockUsdFromBtcMidPriceFn.mockResolvedValue(new DealerPriceServiceError("offline"))
        expect(
          await send({ amount: { currency: "BTC", sats: 21_000 }, kind: "lightning" }),
        ).toBe(true)
      })
    })

    describe("log-only", () => {
      beforeEach(() => mockSendGuardMode.mockReturnValue("log-only"))

      it("runs every check and reports the would-be rejection, but authorises the send", async () => {
        expect(await send({ amount: overLimit })).toBe(true)

        expect(mockConsumeLimiter).toHaveBeenCalledTimes(2)
        expect(lastOpsEvent()).toMatchObject({
          flow: "transfer",
          // Nothing was blocked; the feed must not read as if it was.
          phase: "would-reject",
          status: "pending",
          accountId: ACCOUNT_ID,
          step: SendRejectionReasons.overDailyLimit,
          error: "IntraledgerLimitsExceededError",
          meta: { level: "0", mode: "log-only" },
        })
      })

      it("does not block on a fail-closed condition either — it only reports it", async () => {
        mockUsdFromBtcMidPriceFn.mockResolvedValue(new DealerPriceServiceError("offline"))

        expect(
          await send({ amount: { currency: "BTC", sats: 21_000 }, kind: "lightning" }),
        ).toBe(true)
        expect(lastOpsEvent()?.step).toBe(SendRejectionReasons.limitsUnavailable)
        expect(mockRecordExceptionInCurrentSpan).toHaveBeenCalledWith(
          expect.objectContaining({ level: ErrorLevel.Warn }),
        )
      })

      it("still says nothing about a rate-limited caller", async () => {
        mockConsumeLimiter.mockResolvedValue(new PaymentSendRateLimiterExceededError())
        expect(await send()).toBe(true)
        expect(mockNotifyOpsEvent).not.toHaveBeenCalled()
      })
    })
  })
})
