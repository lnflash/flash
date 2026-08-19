// jest.mock calls are hoisted before imports

// The `fygaroTopupAllowance` resolver is a SEPARATE query with its own file:
// see `fygaro-topup-allowance.spec.ts` next door. Its suite used to live here,
// which meant anyone auditing coverage for that resolver found no file named
// after it and concluded there was none.
const mockGetFygaroTopupStatus = jest.fn()

jest.mock("@app/fygaro/topup-status", () => ({
  getFygaroTopupStatus: (...args: unknown[]) => mockGetFygaroTopupStatus(...args),
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import FygaroTopupStatusQuery from "@graphql/public/root/query/fygaro-topup-status"

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
