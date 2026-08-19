// jest.mock calls are hoisted before imports

const mockGetFygaroTopupStatus = jest.fn()
const mockGetFygaroTopupAllowance = jest.fn()
const mockConsumeLimiter = jest.fn()

jest.mock("@app/fygaro/topup-status", () => ({
  getFygaroTopupStatus: (...args: unknown[]) => mockGetFygaroTopupStatus(...args),
}))

jest.mock("@app/fygaro/topup-allowance", () => ({
  getFygaroTopupAllowance: (...args: unknown[]) => mockGetFygaroTopupAllowance(...args),
}))

jest.mock("@services/rate-limit", () => ({
  consumeLimiter: (...args: unknown[]) => mockConsumeLimiter(...args),
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import { RateLimitConfig } from "@domain/rate-limit"
import { FygaroTopupAllowanceRateLimiterExceededError } from "@domain/rate-limit/errors"
import FygaroTopupStatusQuery from "@graphql/public/root/query/fygaro-topup-status"
import FygaroTopupAllowanceQuery from "@graphql/public/root/query/fygaro-topup-allowance"
import {
  FygaroTopupAllowancePayload,
  FygaroTopupAllowanceUnavailableReasonEnum,
} from "@graphql/public/types/object/fygaro-topup-allowance"

const ACCOUNT_ID = "account-001" as AccountId
const CHECKOUT_ID = "3f5a1c9e-2b7d-4a10-9f33-6c8e2d4b7a51"

const ctx = {
  domainAccount: { id: ACCOUNT_ID, level: 1 },
} as unknown as GraphQLPublicContextAuth

type Query = {
  resolve?: (
    source: null,
    args: Record<string, unknown>,
    context: GraphQLPublicContextAuth,
    info: never,
  ) => Promise<unknown> | unknown
}

const resolve = async (query: Query, args: Record<string, unknown> = {}) => {
  if (!query.resolve) throw new Error("Missing resolver")
  return query.resolve(null, args, ctx, {} as never)
}

type StatusPayload = {
  state: string
  authorizedAmount?: number
  netAmount?: number
  reason?: string
} | null

const askStatus = async (
  status: Record<string, unknown> | undefined,
): Promise<StatusPayload> => {
  mockGetFygaroTopupStatus.mockResolvedValue(
    status === undefined ? { found: false } : { found: true, status },
  )
  return (await resolve(FygaroTopupStatusQuery as Query, {
    checkoutId: CHECKOUT_ID,
  })) as StatusPayload
}

const held = (reason: string, detailCents?: number) => ({
  state: "held-for-review",
  authorizedAmountCents: 6000,
  reason,
  detailCents,
})

beforeEach(() => {
  jest.clearAllMocks()
  mockConsumeLimiter.mockResolvedValue(true)
})

describe("fygaroTopupStatus resolver", () => {
  it("asks only about THIS account's checkout", async () => {
    await askStatus({ state: "processing", authorizedAmountCents: 6000 })

    // The account id comes from the session, never from the argument — the
    // checkout id alone must not be able to name whose payment is being read.
    expect(mockGetFygaroTopupStatus).toHaveBeenCalledWith({
      intentId: CHECKOUT_ID,
      accountId: ACCOUNT_ID,
    })
  })

  it("returns null for an unknown, expired or foreign checkout", async () => {
    expect(await askStatus(undefined)).toBeNull()
  })

  it("answers UNCONFIRMED — not null — when the record could not be READ", async () => {
    // A Redis fault is not an answer about the checkout. Null means "unknown,
    // expired, or not yours", so returning it here tells a customer who may
    // have just been charged that their checkout never existed. UNCONFIRMED is
    // the true sentence: nothing about this payment is confirmed yet.
    mockGetFygaroTopupStatus.mockResolvedValue({ found: false, unavailable: true })

    const result = (await resolve(FygaroTopupStatusQuery as Query, {
      checkoutId: CHECKOUT_ID,
    })) as StatusPayload

    expect(result).toEqual({ state: "unconfirmed" })
    // ...and it must not claim receipt either: PROCESSING says "we have the
    // payment and are crediting it", which we cannot know while the read is
    // failing.
    expect(result?.state).not.toBe("processing")
  })

  it("says nothing about a payment still being processed", async () => {
    // No terminal answer yet, so there is nothing honest to explain. The app
    // shows its "we have your payment" state off the enum alone.
    const result = await askStatus({ state: "processing", authorizedAmountCents: 6000 })

    expect(result).toEqual({
      state: "processing",
      authorizedAmount: 6000,
      netAmount: undefined,
      reason: undefined,
    })
  })

  it("passes UNCONFIRMED through for a checkout with no payment observed", async () => {
    // The state the app must never render as "payment received": the record is
    // written when the LINK is minted, so this is also what a declined card and
    // a cancelled page look like.
    const result = await askStatus({ state: "unconfirmed", authorizedAmountCents: 6000 })

    expect(result).toEqual({
      state: "unconfirmed",
      authorizedAmount: 6000,
      netAmount: undefined,
      reason: undefined,
    })
  })

  it("reports the credited NET, which is not what the customer paid", async () => {
    const result = await askStatus({
      state: "credited",
      authorizedAmountCents: 6000,
      netAmountCents: 5652,
    })

    expect(result).toMatchObject({
      state: "credited",
      authorizedAmount: 6000,
      netAmount: 5652,
      reason: undefined,
    })
  })

  // The threshold class: the customer tripped a rule, the rule is named, and
  // the number that makes it actionable travels with it.
  describe("reasons the customer can act on name their number", () => {
    it("names the REMAINING daily limit", async () => {
      const result = await askStatus(held("daily-limit-exceeded", 2500))

      expect(result?.reason).toBe(
        "This is more than your remaining daily top-up limit of $25.00.",
      )
    })

    it("falls back to the limit without a figure when none was recorded", async () => {
      // An older record, or a stamp written before the threshold was captured.
      // Still true, just less useful — never a fabricated number.
      const result = await askStatus(held("daily-limit-exceeded"))

      expect(result?.reason).toBe("This is more than your remaining daily top-up limit.")
    })

    it("names the single-payment ceiling", async () => {
      expect((await askStatus(held("over-limit", 50000)))?.reason).toBe(
        "Top-ups over $500.00 need a quick manual review.",
      )
    })

    it("names the ceiling generically when none was recorded", async () => {
      expect((await askStatus(held("over-limit")))?.reason).toBe(
        "Top-ups above our automatic limit need a quick manual review.",
      )
    })

    it("names the minimum", async () => {
      expect((await askStatus(held("under-minimum", 1000)))?.reason).toBe(
        "The minimum top-up is $10.00.",
      )
    })

    it("names the minimum generically when none was recorded", async () => {
      expect((await askStatus(held("under-minimum")))?.reason).toBe(
        "This is below the minimum top-up.",
      )
    })

    it("explains an account level that cannot take card top-ups at all", async () => {
      expect((await askStatus(held("no-daily-limit-for-level")))?.reason).toBe(
        "Card top-ups aren't available on your account level yet.",
      )
    })
  })

  // The ours class. A customer who has already been charged must never be told
  // that OUR disabled toggle, unreadable settings row or failed send was
  // something they did — an operator is already being paged for it.
  describe("our own faults are never dressed up as the customer's", () => {
    const OURS = "We've received your payment and are completing it manually."

    it.each([
      "credit-disabled",
      "auto-credit-disabled",
      "settings-unavailable",
      "history-unavailable",
      "non-positive-net",
      "non-usd",
    ])("%s reads as a manual completion, with no number", async (reason) => {
      const result = await askStatus(held(reason, 12500))

      expect(result?.reason).toBe(OURS)
    })

    it("credit-failed reads as a manual completion too", async () => {
      // Stamped by the credit path, not the gate — and retryable, so the state
      // is `failed` while the wording still says we are on it.
      const result = await askStatus({
        state: "failed",
        authorizedAmountCents: 6000,
        reason: "credit-failed",
      })

      expect(result).toMatchObject({ state: "failed", reason: OURS })
    })

    it("intent-mismatch says we could not match it, not that they did wrong", async () => {
      expect((await askStatus(held("intent-mismatch")))?.reason).toBe(
        "We couldn't match this payment to your checkout, so we're completing it by hand.",
      )
    })

    it("an unrecognised reason from an older deployment is ours by default", async () => {
      // The map is exhaustive at compile time, but the string comes off a Redis
      // record a previous deploy may have written. We cannot explain a rule we
      // no longer have, so we must not try to blame the customer for it.
      expect((await askStatus(held("some-reason-we-no-longer-have", 999)))?.reason).toBe(
        OURS,
      )
    })
  })
})

describe("fygaroTopupAllowance resolver", () => {
  it("asks for the caller's own account and level", async () => {
    mockGetFygaroTopupAllowance.mockResolvedValue({ available: false, reason: "x" })

    await resolve(FygaroTopupAllowanceQuery as Query)

    expect(mockGetFygaroTopupAllowance).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      level: 1,
    })
  })

  it("maps the allowance onto the schema's cent fields", async () => {
    const resetsAt = new Date("2026-08-18T02:33:31Z")
    const holdsExpireAt = new Date("2026-08-17T03:00:00Z")
    mockGetFygaroTopupAllowance.mockResolvedValue({
      available: true,
      allowance: {
        limitCents: 12500,
        spentCents: 5000,
        heldCents: 4000,
        remainingCents: 3500,
        singlePaymentLimitCents: 20000,
        minimumCents: 1000,
        resetsAt,
        holdsExpireAt,
      },
    })

    // `remaining` is deliberately NOT `limit - spent`: the account's unpaid
    // checkout links are subtracted from it too, so it answers the same
    // question, with the same number, as the pre-charge gate. Which is why
    // `held` has to ship alongside it — it is the only thing that accounts for
    // the difference.
    expect(await resolve(FygaroTopupAllowanceQuery as Query)).toEqual({
      errors: [],
      allowance: {
        limit: 12500,
        spent: 5000,
        held: 4000,
        remaining: 3500,
        singlePaymentLimit: 20000,
        minimum: 1000,
        resetsAt,
        holdsExpireAt,
      },
      unavailableReason: null,
    })
  })

  it("carries the gate's per-payment bounds, not only the daily headroom", async () => {
    // `remaining` is daily headroom; `singlePaymentLimit` is a SEPARATE gate
    // (fees.ts `over-limit`). An account with $500 of daily room against a $200
    // ceiling that is offered $500 has its charge refused
    // `above-single-payment-limit` — the invite-then-refuse loop, on the query
    // added to end it. Neither bound is exposed anywhere else in the schema.
    mockGetFygaroTopupAllowance.mockResolvedValue({
      available: true,
      allowance: {
        limitCents: 100000,
        spentCents: 0,
        heldCents: 0,
        remainingCents: 50000,
        singlePaymentLimitCents: 20000,
        minimumCents: 1000,
        resetsAt: undefined,
        holdsExpireAt: undefined,
      },
    })

    const { allowance } = (await resolve(FygaroTopupAllowanceQuery as Query)) as {
      allowance: Record<string, unknown>
    }
    expect(allowance.remaining).toBe(50000)
    expect(allowance.singlePaymentLimit).toBe(20000)
    expect(allowance.minimum).toBe(1000)
  })

  it("explains the abandoned-link case: $0 spent, $60 held, and when it comes back", async () => {
    // THE canonical case, and the one that broke the type's contract: a
    // customer mints a $60 link against a $125 cap and closes the page. No
    // payment exists, so `spent` is 0 and `resetsAt` — settled spend only — is
    // null. Reporting only "limit 12500, spent 0, remaining 6500" says the full
    // limit is available while showing $65, and gives the client nothing to
    // render the missing $60 with. `held` names it and `holdsExpireAt` says
    // when it lifts.
    const holdsExpireAt = new Date("2026-08-17T03:15:00Z")
    mockGetFygaroTopupAllowance.mockResolvedValue({
      available: true,
      allowance: {
        limitCents: 12500,
        spentCents: 0,
        heldCents: 6000,
        remainingCents: 6500,
        singlePaymentLimitCents: 20000,
        minimumCents: 1000,
        resetsAt: undefined,
        holdsExpireAt,
      },
    })

    expect(await resolve(FygaroTopupAllowanceQuery as Query)).toEqual({
      errors: [],
      allowance: {
        limit: 12500,
        spent: 0,
        held: 6000,
        remaining: 6500,
        singlePaymentLimit: 20000,
        minimum: 1000,
        resetsAt: undefined,
        holdsExpireAt,
      },
      unavailableReason: null,
    })
  })

  it("reports no hold expiry when nothing is held", async () => {
    mockGetFygaroTopupAllowance.mockResolvedValue({
      available: true,
      allowance: {
        limitCents: 12500,
        spentCents: 5000,
        heldCents: 0,
        remainingCents: 7500,
        singlePaymentLimitCents: 20000,
        minimumCents: 1000,
        resetsAt: new Date("2026-08-18T02:33:31Z"),
        holdsExpireAt: undefined,
      },
    })

    const { allowance } = (await resolve(FygaroTopupAllowanceQuery as Query)) as {
      allowance: Record<string, unknown>
    }
    expect(allowance.held).toBe(0)
    expect(allowance.holdsExpireAt).toBeUndefined()
  })

  // Collapsing all five into one bare null was itself the invite-then-refuse
  // bug: two of them never resolve on their own, so a client that cannot tell
  // them from an ERPNext blip renders the card top-up option and has
  // fygaroCheckoutCreate refuse every attempt, forever.
  it.each([
    ["checkout-disabled", "checkout-disabled"],
    ["settings-unavailable", "settings-unavailable"],
    ["history-unavailable", "history-unavailable"],
    ["reservations-unavailable", "reservations-unavailable"],
    ["no-daily-limit-for-level", "no-daily-limit-for-level"],
  ])("names %s instead of inventing a number", async (reason, wire) => {
    // Still no number — decoration on a screen the customer is still filling
    // in, and a full allowance the charge path will refuse is worse than none.
    // But the client is told WHICH kind of nothing it got.
    mockGetFygaroTopupAllowance.mockResolvedValue({ available: false, reason })

    expect(await resolve(FygaroTopupAllowanceQuery as Query)).toEqual({
      errors: [],
      allowance: null,
      unavailableReason: wire,
    })
  })

  it("distinguishes the PERMANENT refusals from the transient ones", async () => {
    // The whole point of reporting the reason. These two are the states in
    // which fygaroCheckoutCreate refuses every single request — the default
    // rollout state (`fygaro.checkout.enabled` is false) and a level-0 account
    // — so the client must hide the option rather than retry.
    for (const reason of ["checkout-disabled", "no-daily-limit-for-level"]) {
      mockGetFygaroTopupAllowance.mockResolvedValue({ available: false, reason })

      const payload = (await resolve(FygaroTopupAllowanceQuery as Query)) as {
        unavailableReason: string
      }
      expect(payload.unavailableReason).toBe(reason)
    }
  })

  describe("rate limiting", () => {
    it("consumes the per-account limiter BEFORE reading ERPNext", async () => {
      // Cheaper to abuse than fygaroCheckoutCreate next door: no amount
      // argument, so nothing can short-circuit before the trailing-24h ERPNext
      // list query — the read whose failure refuses card top-ups for EVERY
      // user. The field is blocked for API keys, so every caller is a Kratos
      // session and the API-key limiter passes those through untouched.
      mockGetFygaroTopupAllowance.mockResolvedValue({
        available: false,
        reason: "history-unavailable",
      })

      await resolve(FygaroTopupAllowanceQuery as Query)

      expect(mockConsumeLimiter).toHaveBeenCalledWith({
        rateLimitConfig: RateLimitConfig.fygaroTopupAllowance,
        keyToConsume: ACCOUNT_ID,
      })
    })

    it("answers RATE_LIMITED without touching ERPNext once the limiter is spent", async () => {
      mockConsumeLimiter.mockResolvedValue(
        new FygaroTopupAllowanceRateLimiterExceededError(),
      )

      // Named, not bare: "back off" and "card top-ups are switched off" are
      // opposite instructions, and the client cannot act on either if both
      // arrive as an absent allowance.
      expect(await resolve(FygaroTopupAllowanceQuery as Query)).toEqual({
        errors: [],
        allowance: null,
        unavailableReason: "rate-limited",
      })
      expect(mockGetFygaroTopupAllowance).not.toHaveBeenCalled()
    })

    it("answers RATE_LIMITED without touching ERPNext when the limiter STORE is down", async () => {
      // The allowance read fails closed on that same Redis anyway, so refusing
      // here costs an answer the client already handles — and it keeps an
      // outage from becoming unbounded load on the ERPNext read every other
      // card top-up depends on.
      mockConsumeLimiter.mockResolvedValue(new Error("ECONNREFUSED"))

      expect(await resolve(FygaroTopupAllowanceQuery as Query)).toEqual({
        errors: [],
        allowance: null,
        unavailableReason: "rate-limited",
      })
      expect(mockGetFygaroTopupAllowance).not.toHaveBeenCalled()
    })
  })
})

// The resolver returns the enum's INTERNAL value; GraphQL turns that into the
// member name on the wire. Every test above stops one step short of that —
// `resolve()` is called directly, so `GraphQLEnumType.serialize` never runs and
// a value no member carries looks exactly like a value every member carries.
// The six wire strings live in two files (the enum's `value:` entries and the
// resolver's UNAVAILABLE_REASON map); typing both against
// `FygaroTopupAllowanceUnavailableReasonValue` makes a rename a compile error,
// and this makes it a test failure as well.
describe("fygaroTopupAllowance unavailableReason survives GraphQL serialization", () => {
  const serialize = (value: unknown) =>
    FygaroTopupAllowanceUnavailableReasonEnum.serialize(value)

  it.each([
    ["checkout-disabled", "CHECKOUT_DISABLED"],
    ["no-daily-limit-for-level", "LEVEL_NOT_ELIGIBLE"],
    ["settings-unavailable", "SETTINGS_UNAVAILABLE"],
    ["history-unavailable", "HISTORY_UNAVAILABLE"],
    ["reservations-unavailable", "RESERVATIONS_UNAVAILABLE"],
  ])("serializes the %s the resolver returns as %s", async (reason, member) => {
    mockGetFygaroTopupAllowance.mockResolvedValue({ available: false, reason })

    const { unavailableReason } = (await resolve(FygaroTopupAllowanceQuery as Query)) as {
      unavailableReason: string
    }

    // Would throw `Enum "FygaroTopupAllowanceUnavailableReason" cannot
    // represent value: ...` if the two sides had drifted.
    expect(serialize(unavailableReason)).toBe(member)
  })

  it("serializes the rate-limited refusal the resolver owns itself", async () => {
    // The one reason with no app-layer failure behind it: the limiter refuses
    // before `getFygaroTopupAllowance` is ever called, so it is written as a
    // bare literal in the resolver and had nothing at all tying it to the enum.
    mockConsumeLimiter.mockResolvedValue(
      new FygaroTopupAllowanceRateLimiterExceededError(),
    )

    const { unavailableReason } = (await resolve(FygaroTopupAllowanceQuery as Query)) as {
      unavailableReason: string
    }

    expect(serialize(unavailableReason)).toBe("RATE_LIMITED")
  })

  it("still refuses a value no member carries", () => {
    // The assertions above are only worth something if serialize can say no.
    expect(() => serialize("rate_limited")).toThrow()
  })
})

// `FygaroTopupAllowancePayload` was the only `*Payload` in the public schema
// without `errors` — including the four that queries, not mutations, already
// return. Mobile codegen and the shared "did this payload error" helpers key
// off that field, so a payload without it opts out of the one convention the
// suffix promises.
describe("fygaroTopupAllowance payload keeps the payload contract", () => {
  it("declares errors as a non-null list of IError", () => {
    const errors = FygaroTopupAllowancePayload.getFields().errors
    expect(errors).toBeDefined()
    expect(String(errors.type)).toBe("[Error!]!")
  })

  it("returns an empty errors list on every path, refusals included", async () => {
    mockGetFygaroTopupAllowance.mockResolvedValue({
      available: false,
      reason: "history-unavailable",
    })
    const refused = (await resolve(FygaroTopupAllowanceQuery as Query)) as {
      errors: unknown[]
    }
    expect(refused.errors).toEqual([])

    mockGetFygaroTopupAllowance.mockResolvedValue({
      available: true,
      allowance: {
        limitCents: 12500,
        spentCents: 0,
        heldCents: 0,
        remainingCents: 12500,
        singlePaymentLimitCents: 20000,
        minimumCents: 1000,
        resetsAt: undefined,
        holdsExpireAt: undefined,
      },
    })
    const answered = (await resolve(FygaroTopupAllowanceQuery as Query)) as {
      errors: unknown[]
    }
    expect(answered.errors).toEqual([])

    mockConsumeLimiter.mockResolvedValue(
      new FygaroTopupAllowanceRateLimiterExceededError(),
    )
    const limited = (await resolve(FygaroTopupAllowanceQuery as Query)) as {
      errors: unknown[]
    }
    expect(limited.errors).toEqual([])
  })
})
