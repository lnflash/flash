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
const mockAddAttributesToCurrentSpan = jest.fn()
const mockAsyncRunInSpan = jest.fn()
jest.mock("@services/tracing", () => ({
  recordExceptionInCurrentSpan: (args: unknown) => mockRecordExceptionInCurrentSpan(args),
  // The guard opens its own span so the census lands on ONE name whatever the
  // call path — ahead of this, `addAttributesToCurrentSpan` wrote to whichever
  // span happened to be active (`services.lock.lockPaymentIdempotencyKey` on
  // the six keyed rails, the GraphQL resolver span everywhere else). Recorded
  // and executed, so the assertions below can pin the name the runbook tells
  // operators to query.
  //
  // The `instanceof Error` branch is modelled, not elided: the real helper does
  // `if (ret instanceof Error) recordException(span, ret)` on whatever the
  // wrapped function returns (src/services/tracing.ts). A passthrough mock left
  // "keeps the span-exception signal for limits-unavailable only" unfalsifiable
  // — returning `outcome.error` instead of `outcome` from `runInGuardSpan`
  // would keep that test green while production recorded a span exception for
  // every over-limit rejection on the platform, burying the one signal the
  // runbook says to page on. Routed into the same spy because both paths end in
  // the same place: an exception recorded on the guard's span.
  asyncRunInSpan: async <T>(
    spanName: string,
    options: unknown,
    fn: () => Promise<T>,
  ): Promise<T> => {
    mockAsyncRunInSpan(spanName, options)
    const ret = await fn()
    if (ret instanceof Error) mockRecordExceptionInCurrentSpan({ error: ret })
    return ret
  },
  SemanticAttributes: {
    CODE_FUNCTION: "code.function",
    CODE_NAMESPACE: "code.namespace",
  },
  // Deliberately NOT a passthrough, because the real one is not: it sets an
  // attribute only `if (value)` (src/services/tracing.ts), so every falsy value
  // is dropped before it reaches a span. That filter is pinned by
  // test/flash/unit/services/tracing.spec.ts and mirrored here, so the census
  // assertions below read what production would actually record rather than
  // what this file passed in. A passthrough mock green-lit
  // `"sendGuard.level": AccountLevel.Zero` — a value production dropped for
  // every level-0 account, i.e. the whole cohort the rollout exists to count.
  addAttributesToCurrentSpan: (attributes: Record<string, unknown>) =>
    mockAddAttributesToCurrentSpan(
      Object.fromEntries(Object.entries(attributes).filter(([, value]) => value)),
    ),
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
  SEND_GUARD_SPAN_NAME,
  SendRejectionReasons,
  authorizeSend,
  gateSend,
  __resetOpsEventCoalescingForTest,
} from "@app/payments/authorize-send"

// Type-only: no runtime import, so the barrel's module graph (Redis-backed rate
// limiter, IBEX client) is never loaded by this spec.
import type * as PaymentsBarrel from "@app/payments"

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
import { LnInvoiceDecodeError } from "@domain/bitcoin/lightning/errors"
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

const lastSpanAttributes = () => mockAddAttributesToCurrentSpan.mock.calls.at(-1)?.[0]

// The rail-local gate, as `lnInvoicePaymentSend` calls it: an invoice the new
// bolt11 decode refuses, before any amount is knowable.
const gateUndecodableInvoice = (
  overrides: Partial<Parameters<typeof gateSend>[0]> = {},
): Promise<true | ApplicationError> =>
  gateSend({
    error: new LnInvoiceDecodeError("bad bolt11"),
    reason: SendRejectionReasons.undecodableInvoice,
    senderAccount: account(AccountLevel.Zero),
    senderWalletId: WALLET_ID,
    kind: "lightning",
    ...overrides,
  })

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
    // A muted count is cleared only by being delivered, so it would otherwise
    // carry from one test into the next test's first ops event.
    __resetOpsEventCoalescingForTest()
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

    // Coalesced, not silenced. A retry loop must not bury the 50-deep ops feed,
    // but a check with zero observable output cannot be read during the very
    // rollout the mode switch exists for: an operator would count a week of
    // would-reject embeds, see no rate-limit signal by construction, flip to
    // enforce, and hand a payout batch a wall of TooManyRequestErrors.
    it("coalesces a retrying rate-limited caller to one ops event per window", async () => {
      mockConsumeLimiter.mockResolvedValue(new PaymentSendRateLimiterExceededError())

      for (let i = 0; i < 25; i++) {
        expect(await send()).toBeInstanceOf(PaymentSendRateLimiterExceededError)
      }

      expect(mockNotifyOpsEvent).toHaveBeenCalledTimes(1)
      expect(lastOpsEvent()).toMatchObject({
        step: SendRejectionReasons.rateLimited,
        error: "PaymentSendRateLimiterExceededError",
      })
      // Not an infrastructure fault — no span exception, unlike limits-unavailable.
      expect(mockRecordExceptionInCurrentSpan).not.toHaveBeenCalled()

      // ...and the 24 it swallowed are recoverable from the feed.
      jest.advanceTimersByTime(OPS_EVENT_COALESCE_MS + 1)
      await send()
      expect(lastOpsEvent()?.meta.muted).toBe("24")
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

    // The shape a staleness cutoff silently lost: a short blip mutes a pile of
    // rejections, the fault clears, and no further event of that reason arrives
    // for a long time. Ops must not read the feed as "one send was affected".
    it("keeps the muted count through an arbitrarily long silence, and dates it", async () => {
      mockConsumeLimiter.mockResolvedValue(new UnknownRateLimitServiceError("redis down"))
      for (let i = 0; i < 500; i++) await send()
      expect(mockNotifyOpsEvent).toHaveBeenCalledTimes(1)

      // Fault clears; nothing of this reason happens for an hour.
      jest.advanceTimersByTime(60 * 60 * 1000)
      await send()

      expect(lastOpsEvent()?.meta.muted).toBe("499")
      // Dated, so a late count reads as an older incident rather than as 499
      // rejections that just happened.
      expect(Number(lastOpsEvent()?.meta.mutedAgeS)).toBeGreaterThanOrEqual(3600)
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

    // `kind` is the RAIL, not the destination. A bolt11 or LN-address payment
    // to another Flash user never leaves Flash, but the resolver hands the
    // guard `kind: "lightning"` / `"lnurl"` regardless — the destination is not
    // resolved until the payment flow is built, after the guard — so it is
    // judged against `withdrawalLimit`. docs/send-guard.md (check 3) states
    // that approximation and its scope: level 1 is the only level whose two
    // limits differ, so it is the only level on which the distinction can
    // change an outcome. Both halves are pinned here on purpose. Raising
    // `accountLimits.withdrawal.level.1` to 200000 — one of the two options the
    // doc says to pick between before enforcing — fails this test, which is the
    // reminder that the doc and the decision move with it.
    it("judges an inside-Flash lightning send by the rail, and only level 1 can tell", async () => {
      expect(L1.withdrawalLimit).toBe(100_000)
      expect(L1.intraLedgerLimit).toBe(200_000)
      for (const limits of [L0, L2, L3]) {
        expect(limits.withdrawalLimit).toBe(limits.intraLedgerLimit)
      }

      // $1,500 from an L1 account to another Flash user, over their invoice.
      const insideFlash = { currency: "USD", cents: 150_000 } as const
      expect(
        await send({
          senderAccount: account(AccountLevel.One),
          amount: insideFlash,
          kind: "lightning",
        }),
      ).toBeInstanceOf(WithdrawalLimitsExceededError)

      // ...and in the census it is `lightning`, indistinguishable from a
      // genuinely external send. That is what the `over-daily-limit` bullet in
      // the runbook warns the operator about before they triage the bucket.
      expect(lastSpanAttributes()).toMatchObject({
        "sendGuard.rejection": SendRejectionReasons.overDailyLimit,
        "sendGuard.kind": "lightning",
        "sendGuard.level": "1",
      })

      // The same $1,500 to the same user, over their username, is allowed.
      expect(
        await send({
          senderAccount: account(AccountLevel.One),
          amount: insideFlash,
          kind: "intraledger",
        }),
      ).toBe(true)
    })

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

  // The rail-local gate on `lnInvoicePaymentSend`: the bolt11 decode, which has
  // to run before the amount is knowable and therefore cannot live inside
  // `evaluateSend`. It is the one guard outcome an authenticated caller can
  // produce from a single request field — the LnPaymentRequest scalar is
  // /^ln[a-z0-9]+$/i, so `paymentRequest: "lnx"` reaches `decodeInvoice` and
  // fails it — and for a while it was neither budgeted nor coalesced.
  describe("gateSend (the rail-local decode gate)", () => {
    // log-only is what ships: the budget charge and the ops-event ceiling are
    // the same in every mode, and the mode only decides the return value.
    beforeEach(() => mockSendGuardMode.mockReturnValue("log-only"))

    it("charges the attempt budget, so a refused invoice is not free to produce", async () => {
      expect(await gateUndecodableInvoice()).toBe(true)

      expect(mockConsumeLimiter.mock.calls).toEqual([
        [{ rateLimitConfig: RateLimitConfig.paymentSend, keyToConsume: ACCOUNT_ID }],
        [{ rateLimitConfig: RateLimitConfig.paymentSendDaily, keyToConsume: ACCOUNT_ID }],
      ])
    })

    // Exactly one charge per HTTP request: a request that reaches the gate
    // never reaches `authorizeSend`, and vice versa. Charging in both places
    // would silently halve every caller's budget.
    it("is the only charge on the requests it handles", async () => {
      await gateUndecodableInvoice()
      expect(mockConsumeLimiter).toHaveBeenCalledTimes(2)

      mockConsumeLimiter.mockClear()
      await send()
      expect(mockConsumeLimiter).toHaveBeenCalledTimes(2)
    })

    it("reports the caller as rate-limited once their budget is spent", async () => {
      mockConsumeLimiter.mockResolvedValue(new PaymentSendRateLimiterExceededError())
      mockSendGuardMode.mockReturnValue("enforce")

      const result = await gateUndecodableInvoice()

      expect(result).toBeInstanceOf(PaymentSendRateLimiterExceededError)
      expect(lastOpsEvent()?.step).toBe(SendRejectionReasons.rateLimited)
    })

    // The bug this case exists for: `undecodable-invoice` was absent from
    // COALESCED_REASONS while the code's justification for leaving reasons
    // uncoalesced — "each caller's attempt budget already bounds them" — was
    // false for this one, because the decode ran ahead of the budget. A client
    // loop (a truncated QR scan retrying, or a deliberate one) posted one embed
    // per HTTP request into a shared 50-deep FIFO that drops its oldest
    // entries, starving the verification / cashout / deposit feed and
    // truncating the very would-reject census this rollout depends on.
    it("posts at most one ops event per window however many invoices it refuses", async () => {
      for (let i = 0; i < 25; i++) {
        expect(await gateUndecodableInvoice()).toBe(true)
      }

      expect(mockNotifyOpsEvent).toHaveBeenCalledTimes(1)
      expect(lastOpsEvent()).toMatchObject({
        step: SendRejectionReasons.undecodableInvoice,
        error: "LnInvoiceDecodeError",
      })

      // ...and the 24 it swallowed are still countable from the feed.
      jest.advanceTimersByTime(OPS_EVENT_COALESCE_MS + 1)
      await gateUndecodableInvoice()
      expect(mockNotifyOpsEvent).toHaveBeenCalledTimes(2)
      expect(lastOpsEvent()?.meta.muted).toBe("24")
    })

    it("still reports every refusal on the span, coalesced or not", async () => {
      for (let i = 0; i < 25; i++) await gateUndecodableInvoice()

      expect(mockNotifyOpsEvent).toHaveBeenCalledTimes(1)
      expect(mockAddAttributesToCurrentSpan).toHaveBeenCalledTimes(25)
      expect(lastSpanAttributes()).toMatchObject({
        "sendGuard.rejection": SendRejectionReasons.undecodableInvoice,
      })
    })

    it("refuses the invoice when enforcing and reports it as rejected", async () => {
      mockSendGuardMode.mockReturnValue("enforce")
      const error = new LnInvoiceDecodeError("bad bolt11")

      expect(await gateUndecodableInvoice({ error })).toBe(error)
      expect(lastOpsEvent()).toMatchObject({ phase: "rejected", status: "failed" })
    })

    it("does nothing at all on off — no budget, no event, no span", async () => {
      mockSendGuardMode.mockReturnValue("off")

      expect(await gateUndecodableInvoice()).toBe(true)
      expect(mockConsumeLimiter).not.toHaveBeenCalled()
      expect(mockNotifyOpsEvent).not.toHaveBeenCalled()
      expect(mockAddAttributesToCurrentSpan).not.toHaveBeenCalled()
      expect(mockAsyncRunInSpan).not.toHaveBeenCalled()
    })
  })

  // The ops feed is the human instrument and a bad counter: it no-ops entirely
  // when OPS_DISCORD_WEBHOOK_URL is unset, drops its oldest entries on overflow
  // behind an unattributed "N events dropped" summary, and coalesces the
  // unbounded reasons. The go/no-go for `enforce` is "count them by reason", so
  // the count has to come from somewhere lossless.
  describe("the rejection census on the span", () => {
    it.each([
      [
        "over-daily-limit",
        { amount: { currency: "USD", cents: L0.intraLedgerLimit + 1 } as const },
        SendRejectionReasons.overDailyLimit,
      ],
      [
        "invalid-amount",
        { amount: { currency: "USD", cents: -1 } as const },
        SendRejectionReasons.invalidAmount,
      ],
    ])("records %s on the span, not only in Discord", async (_label, args, reason) => {
      await send(args)

      expect(mockAddAttributesToCurrentSpan).toHaveBeenCalledTimes(1)
      expect(lastSpanAttributes()).toMatchObject({
        "sendGuard.rejection": reason,
        "sendGuard.mode": "enforce",
        "sendGuard.kind": "intraledger",
        "sendGuard.level": "0",
      })
    })

    // The cohort the rollout exists to measure. `AccountLevel.Zero === 0` and
    // `addAttributesToCurrentSpan` drops falsy values, so a numeric level never
    // reached a span for a level-0 account: `sendGuard.level = 0` matched
    // nothing in tracing, and "the attribute is absent" is documented nowhere
    // as meaning level 0. Every level goes on as a string for that reason.
    const levelCases: [string, AccountLevel | undefined, string][] = [
      ["a level-0 account", AccountLevel.Zero, "0"],
      ["an account with no level at all, read as level 0", undefined, "0"],
      ["a level that is set", AccountLevel.Two, "2"],
    ]
    it.each(levelCases)(
      "counts %s by a value the census can match on",
      async (_label, level, emitted) => {
        const limits = getAccountLimits({ level })
        await send({
          senderAccount: account(level),
          amount: { currency: "USD", cents: limits.intraLedgerLimit + 1 },
        })

        expect(lastSpanAttributes()["sendGuard.level"]).toBe(emitted)
      },
    )

    // Numeric, unlike the level: this is the measure the rollout aggregates —
    // step 3 of the runbook decides whether to raise a level's limit from the
    // distribution of refused amounts, which needs MAX/percentiles, and string
    // ordering would sort "9900" above "125000".
    it("carries the amount that was refused as a number, so it can be aggregated", async () => {
      await send({ amount: { currency: "USD", cents: L0.intraLedgerLimit + 1 } })
      expect(lastSpanAttributes()["sendGuard.cents"]).toBe(L0.intraLedgerLimit + 1)
    })

    it("emits the level as a string label and the amount as a number in the same span", async () => {
      await send({ amount: { currency: "USD", cents: L0.intraLedgerLimit + 1 } })
      const attrs = lastSpanAttributes()
      // A level-0 (or level-less) account must be countable: "0" is present,
      // never dropped as falsy.
      expect(attrs["sendGuard.level"]).toBe("0")
      expect(typeof attrs["sendGuard.cents"]).toBe("number")
    })

    it("omits the amount when the guard never got one", async () => {
      mockConsumeLimiter.mockResolvedValue(new PaymentSendRateLimiterExceededError())
      await send()
      // Array path, not "sendGuard.cents": jest reads a dotted string as a path
      // (`sendGuard` -> `cents`), so the string form passes whether the key is
      // there or not.
      expect(lastSpanAttributes()).not.toHaveProperty(["sendGuard.cents"])
    })

    // The case the ops feed cannot answer: 50 identical rejections, one embed.
    it("counts every rejection even while the ops feed is coalescing them away", async () => {
      mockConsumeLimiter.mockResolvedValue(new UnknownRateLimitServiceError("redis down"))

      for (let i = 0; i < 50; i++) await send()

      expect(mockNotifyOpsEvent).toHaveBeenCalledTimes(1)
      expect(mockAddAttributesToCurrentSpan).toHaveBeenCalledTimes(50)
    })

    it("records the mode, so log-only and enforce rejections are countable apart", async () => {
      mockSendGuardMode.mockReturnValue("log-only")
      expect(
        await send({ amount: { currency: "USD", cents: L0.intraLedgerLimit + 1 } }),
      ).toBe(true)
      expect(lastSpanAttributes()["sendGuard.mode"]).toBe("log-only")
    })

    it("says nothing when there is nothing to say", async () => {
      expect(await send()).toBe(true)
      expect(mockAddAttributesToCurrentSpan).not.toHaveBeenCalled()
    })

    // The census has to be queryable by ONE span name.
    // `addAttributesToCurrentSpan` writes to whatever span is active, and that
    // span differs by call path: on the six rails that take an
    // `idempotencyKey` the guard runs inside
    // `LockService().lockPaymentIdempotencyKey`, which
    // `wrapAsyncFunctionsToRunInSpan` makes the active span, so the attributes
    // landed on `services.lock.lockPaymentIdempotencyKey`; without a key, and
    // on both on-chain rails, they landed on the GraphQL resolver span. An
    // operator scoping the go/no-go query to one of those names counts a
    // fraction of the traffic — and the fraction that goes missing is the newer
    // mobile clients that send idempotency keys, i.e. exactly the traffic the
    // flip to enforce is judged on. So the guard opens its own span.
    it("opens the guard's own span, so one query counts every call path", async () => {
      await send({ amount: { currency: "USD", cents: L0.intraLedgerLimit + 1 } })

      expect(SEND_GUARD_SPAN_NAME).toBe("app.payments.authorizeSend")
      expect(mockAsyncRunInSpan.mock.calls).toEqual([
        [
          SEND_GUARD_SPAN_NAME,
          {
            attributes: {
              "code.function": "authorizeSend",
              "code.namespace": "app.payments",
            },
          },
        ],
      ])
      // Opened BEFORE the census is written, not around some later step: the
      // whole point is that the attributes land on the guard's span rather than
      // on whatever the caller had open.
      expect(mockAsyncRunInSpan.mock.invocationCallOrder[0]).toBeLessThan(
        mockAddAttributesToCurrentSpan.mock.invocationCallOrder[0],
      )
    })

    // `undecodable-invoice` is `lnInvoicePaymentSend`-only and coalesced in the
    // feed, so the span is the only place it can be counted. A second span name
    // here would reintroduce exactly the undercount above for the one reason
    // that has nowhere else to be read.
    it("reports the decode gate onto the same span name, marked by entry point", async () => {
      await gateUndecodableInvoice()

      expect(mockAsyncRunInSpan.mock.calls).toEqual([
        [
          SEND_GUARD_SPAN_NAME,
          {
            attributes: {
              "code.function": "gateSend",
              "code.namespace": "app.payments",
            },
          },
        ],
      ])
      expect(lastSpanAttributes()).toMatchObject({
        "sendGuard.rejection": SendRejectionReasons.undecodableInvoice,
      })
      expect(mockAsyncRunInSpan.mock.invocationCallOrder[0]).toBeLessThan(
        mockAddAttributesToCurrentSpan.mock.invocationCallOrder[0],
      )
    })

    // `asyncRunInSpan` records a span exception for any Error the wrapped
    // function returns. An enforced over-limit rejection is an ordinary user
    // outcome, and letting it out through the span would bury the one signal
    // the runbook says to alert on — `limits-unavailable`, "the guard cannot
    // decide" — under every capped payment on the platform.
    it("keeps the span-exception signal for limits-unavailable only, even when enforcing", async () => {
      expect(
        await send({ amount: { currency: "USD", cents: L0.intraLedgerLimit + 1 } }),
      ).toBeInstanceOf(IntraledgerLimitsExceededError)
      expect(mockRecordExceptionInCurrentSpan).not.toHaveBeenCalled()
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
        // Not even a span: `off` is off.
        expect(mockAsyncRunInSpan).not.toHaveBeenCalled()
        expect(mockAddAttributesToCurrentSpan).not.toHaveBeenCalled()
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

      it("reports a rate-limited caller as would-reject rather than saying nothing", async () => {
        mockConsumeLimiter.mockResolvedValue(new PaymentSendRateLimiterExceededError())

        expect(await send()).toBe(true)

        expect(lastOpsEvent()).toMatchObject({
          phase: "would-reject",
          step: SendRejectionReasons.rateLimited,
          meta: { mode: "log-only" },
        })
      })
    })
  })
})

// The guard's module is imported directly everywhere it is used, but
// `src/app/payments/index.ts` also decides what lands on the `Payments` public
// surface. `export * from "./authorize-send"` put
// `__resetOpsEventCoalescingForTest` there — a test-only mutator of the
// ops-event coalescing windows, one autocomplete away from a request handler,
// and calling it drops every accumulated `muted` count, making the ops feed
// silently lossy in exactly the way the coalescing design exists to prevent.
//
// This is a type-level test and `yarn tsc-check` covers test/**, so the
// annotation below IS the test: put the wildcard back and it becomes an
// "Unused '@ts-expect-error' directive" error. Keeping it type-only also means
// this spec never loads the barrel's module graph at runtime.
describe("the Payments barrel surface", () => {
  it("re-exports the guard but not the test-only coalescing reset", () => {
    type Exported = [
      typeof PaymentsBarrel.authorizeSend,
      typeof PaymentsBarrel.gateSend,
      typeof PaymentsBarrel.SendRejectionReasons,
      typeof PaymentsBarrel.OPS_EVENT_COALESCE_MS,
      typeof PaymentsBarrel.SEND_GUARD_SPAN_NAME,
      // @ts-expect-error test-only module-state mutator: never on `Payments`
      typeof PaymentsBarrel.__resetOpsEventCoalescingForTest,
    ]

    const surface: Exported | null = null
    expect(surface).toBeNull()
  })
})
