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
