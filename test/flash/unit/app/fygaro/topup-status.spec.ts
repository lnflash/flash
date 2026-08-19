const mockReadIntent = jest.fn()

jest.mock("@services/fygaro/checkout-intent-store", () => ({
  readIntent: (...args: unknown[]) => mockReadIntent(...args),
}))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getFygaroTopupStatus } = require("@app/fygaro/topup-status")

const INTENT = {
  intentId: "intent-1",
  accountId: "acct-1",
  username: "jaceth2009",
  amountCents: 6000,
  currency: "USD",
  createdAtMs: 1_787_000_000_000,
}

const ask = (accountId = "acct-1") =>
  getFygaroTopupStatus({ intentId: "intent-1", accountId })

beforeEach(() => {
  jest.clearAllMocks()
  mockReadIntent.mockResolvedValue({ found: true, intent: { ...INTENT } })
})

describe("getFygaroTopupStatus", () => {
  it("does NOT claim a payment for a record that only proves a link was minted", async () => {
    // The record is written by saveIntent at CHECKOUT-CREATE time — before the
    // customer has seen the payment page. Reading "no outcome" as "processing"
    // therefore told a customer whose card was DECLINED that we had their
    // payment and were crediting it, since the payment page closes on a decline
    // exactly as it does on a success. Money that was never taken, asserted by
    // the server: the same unbacked claim this feature exists to delete.
    const res = await ask()

    expect(res.found).toBe(true)
    expect(res.status).toMatchObject({
      state: "unconfirmed",
      authorizedAmountCents: 6000,
    })
    expect(res.status.state).not.toBe("processing")
    expect(res.status.netAmountCents).toBeUndefined()
  })

  it("reports processing only once the webhook has actually seen the payment", async () => {
    // `received` is the webhook stamping "this payment exists" the moment it
    // records it. THAT is what makes "we have your payment, we're crediting it"
    // a claim the server can back.
    mockReadIntent.mockResolvedValue({
      found: true,
      intent: { ...INTENT, outcome: { state: "received", atMs: 1 } },
    })
    const res = await ask()

    expect(res.status).toMatchObject({ state: "processing", authorizedAmountCents: 6000 })
  })

  it("reports the credited net, which is not what the customer paid", async () => {
    mockReadIntent.mockResolvedValue({
      found: true,
      intent: {
        ...INTENT,
        outcome: { state: "credited", netAmountCents: 5652, atMs: 1 },
      },
    })
    const res = await ask()

    expect(res.status).toMatchObject({
      state: "credited",
      authorizedAmountCents: 6000,
      netAmountCents: 5652,
    })
  })

  it("carries the reason and its threshold for a held payment", async () => {
    mockReadIntent.mockResolvedValue({
      found: true,
      intent: {
        ...INTENT,
        outcome: {
          state: "held-for-review",
          reason: "daily-limit-exceeded",
          detailCents: 12500,
          atMs: 1,
        },
      },
    })
    const res = await ask()

    expect(res.status).toMatchObject({
      state: "held-for-review",
      reason: "daily-limit-exceeded",
      detailCents: 12500,
    })
  })

  it("reports a failed credit as failed, not as anything terminal-sounding", async () => {
    mockReadIntent.mockResolvedValue({
      found: true,
      intent: {
        ...INTENT,
        outcome: { state: "failed", reason: "credit-failed", atMs: 1 },
      },
    })
    const res = await ask()

    expect(res.status).toMatchObject({ state: "failed", reason: "credit-failed" })
  })

  it("degrades an outcome state this build has no member for to unconfirmed", async () => {
    // `outcome.state` is a string off a Redis record ANOTHER deployment wrote,
    // and it is handed straight to a GraphQL enum. Passing an unrecognised one
    // through threw `Enum "FygaroTopupState" cannot represent value: ...` on
    // the status screen of a customer who has just been charged — a hard error
    // over a record we can read perfectly well. `unconfirmed` asserts nothing.
    mockReadIntent.mockResolvedValue({
      found: true,
      intent: {
        ...INTENT,
        outcome: { state: "refunded", netAmountCents: 5652, atMs: 1 },
      },
    })
    const res = await ask()

    expect(res.found).toBe(true)
    expect(res.status.state).toBe("unconfirmed")
    // ...and specifically not dressed up as receipt, which is the one thing an
    // unknown state can never be assumed to mean.
    expect(res.status.state).not.toBe("processing")
    // The net is stamped alongside the state we just refused to believe, so it
    // does not survive the degrade either (see the test below).
    expect(res.status.netAmountCents).toBeUndefined()
  })

  it("drops the net, reason and threshold that hang off an unrecognised state", async () => {
    // Degrading only `state` fixed the field that THROWS and left the two that
    // carry the same claim in words: a newer deployment's `refunded` record
    // came back as UNCONFIRMED — "NEVER render this as 'payment received'" —
    // with a $56.52 net and, since `customerReason` maps every unknown reason
    // to ours, the sentence "We've received your payment and are completing it
    // manually". A vocabulary we do not have is not partially trustworthy.
    mockReadIntent.mockResolvedValue({
      found: true,
      intent: {
        ...INTENT,
        outcome: {
          state: "refunded",
          reason: "refunded-by-provider",
          netAmountCents: 5652,
          detailCents: 12500,
          atMs: 1,
        },
      },
    })
    const res = await ask()

    expect(res.status.state).toBe("unconfirmed")
    expect(res.status.netAmountCents).toBeUndefined()
    expect(res.status.reason).toBeUndefined()
    expect(res.status.detailCents).toBeUndefined()
    // The authorised amount is not the outcome's to invalidate — it comes off
    // the intent WE minted, and the client is owed the echo either way.
    expect(res.status.authorizedAmountCents).toBe(6000)
  })

  it("never reveals another account's payment", async () => {
    // The id is a uuid, so guessing is impractical — but payment state is
    // exactly the thing that must not leak on a bare id match.
    const res = await ask("someone-else")

    expect(res.found).toBe(false)
  })

  it("answers identically for a wrong account and an unknown id", async () => {
    // Distinguishing them would turn this into an oracle for whether an
    // arbitrary checkout id exists.
    const wrongAccount = await ask("someone-else")
    mockReadIntent.mockResolvedValue({ found: false })
    const unknown = await ask()

    expect(wrongAccount).toEqual(unknown)
  })

  it("reports not-found for an expired or evicted intent", async () => {
    mockReadIntent.mockResolvedValue({ found: false })

    expect((await ask()).found).toBe(false)
  })

  it("distinguishes 'we could not read it' from 'it does not exist'", async () => {
    // readIntent is fail-open by design: EVERY cache error, not just a miss,
    // comes back as found:false. Collapsing that into the ordinary miss makes
    // the resolver tell a customer who has just been charged that their
    // checkout never existed — at the worst possible moment to say it.
    mockReadIntent.mockResolvedValue({ found: false, unavailable: true })

    expect(await ask()).toEqual({ found: false, unavailable: true })
  })

  it("does not mark an ordinary miss as unavailable", async () => {
    // Or the resolver would answer UNCONFIRMED — "keep polling" — for a
    // checkout id that will never resolve, forever.
    mockReadIntent.mockResolvedValue({ found: false })

    expect(await ask()).toEqual({ found: false })
  })

  it("never reports another account's checkout as merely unavailable", async () => {
    // The cross-account guard must stay a flat "no". Leaking "this id exists
    // but we cannot read it right now" would turn the query into the existence
    // oracle the guard exists to prevent.
    mockReadIntent.mockResolvedValue({ found: true, intent: { ...INTENT } })

    expect(await ask("someone-else")).toEqual({ found: false })
  })
})
