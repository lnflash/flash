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
  it("reports processing while no outcome has been recorded", async () => {
    // The webhook may not have been delivered yet. "Processing" is the honest
    // answer; the app's current behaviour — asserting a completed deposit off a
    // Fygaro redirect — is not.
    const res = await ask()

    expect(res.found).toBe(true)
    expect(res.status).toMatchObject({ state: "processing", authorizedAmountCents: 6000 })
    expect(res.status.netAmountCents).toBeUndefined()
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
})
