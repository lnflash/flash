import { AccountLevel } from "@domain/accounts"
import { parseCustomReference } from "@services/fygaro/checkout"

const mockGetFygaroSettings = jest.fn()
const mockSumPrior = jest.fn()
const mockSaveIntent = jest.fn()

jest.mock("@services/fygaro/webhook-server/fygaro-settings", () => ({
  getFygaroSettings: (...args: unknown[]) => mockGetFygaroSettings(...args),
}))
jest.mock("@services/frappe/BridgeTransferRequestWriter", () => ({
  sumFygaroTopupGrossCentsLast24h: (...args: unknown[]) => mockSumPrior(...args),
}))
jest.mock("@services/fygaro/checkout-intent-store", () => ({
  newIntentId: () => "intent-fixed",
  saveIntent: (...args: unknown[]) => mockSaveIntent(...args),
}))

const CHECKOUT = {
  enabled: true,
  buttonUrl: "https://fygaro.com/en/pb/ABC123",
  keyId: "key-1",
  ttlSeconds: 900,
}

jest.mock("@config", () => ({
  get FygaroConfig() {
    return {
      checkout: mockCheckoutConfig,
      webhook: { secrets: { "key-1": "shared-secret" } },
    }
  },
}))

let mockCheckoutConfig: typeof CHECKOUT = { ...CHECKOUT }

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { authorizeFygaroTopup } = require("@app/fygaro/authorize-topup")

const SETTINGS = {
  autoCreditEnabled: true,
  minimumTopup: 5, // USD
  autoCreditLimit: 200, // USD, single payment
  dailyTopupLimits: { 1: 100, 2: 500 },
}

const authorize = (overrides: Record<string, unknown> = {}) =>
  authorizeFygaroTopup({
    accountId: "acct-1",
    username: "jaceth2009",
    level: AccountLevel.One,
    amountCents: 8000,
    nowMs: 1_700_000_000_000,
    ...overrides,
  })

beforeEach(() => {
  jest.clearAllMocks()
  mockCheckoutConfig = { ...CHECKOUT }
  mockGetFygaroSettings.mockResolvedValue({ ...SETTINGS })
  mockSumPrior.mockResolvedValue(0)
  mockSaveIntent.mockResolvedValue(true)
})

describe("authorizeFygaroTopup", () => {
  it("authorises a clean request and signs the amount into the URL", async () => {
    const res = await authorize()

    expect(res.authorized).toBe(true)
    expect(res.checkout.url).toContain("?jwt=")
    // The editable query parameters are exactly what this change removes.
    expect(res.checkout.url).not.toContain("amount=")
    expect(res.checkout.url).not.toContain("custom_reference=")
  })

  it("stores the intent under the same reference it signed", async () => {
    const res = await authorize()

    const [{ intent }] = mockSaveIntent.mock.calls[0]
    expect(intent).toMatchObject({
      intentId: "intent-fixed",
      accountId: "acct-1",
      username: "jaceth2009",
      amountCents: 8000,
    })
    // If these two ever diverge, the webhook cross-check silently stops matching.
    const signed = JSON.parse(
      Buffer.from(res.checkout.url.split("?jwt=")[1].split(".")[1], "base64").toString(),
    )
    expect(parseCustomReference(signed.custom_reference)).toEqual({
      username: intent.username,
      intentId: intent.intentId,
    })
  })

  it("reports what is left after the authorised amount, not before it", async () => {
    // $100 daily limit, $20 already spent, asking for $30 → $50 left after.
    mockSumPrior.mockResolvedValue(2000)
    const res = await authorize({ amountCents: 3000 })

    expect(res.authorized).toBe(true)
    expect(res.remainingAllowanceCents).toBe(5000)
  })

  it("refuses the amount that would have gone through before this change", async () => {
    // The 2026-08-16 incident: allowance nearly used up, customer edits the
    // amount in the webview, gets charged, and the webhook refuses the credit.
    mockSumPrior.mockResolvedValue(9500)
    const res = await authorize({ amountCents: 8000 })

    expect(res.authorized).toBe(false)
    expect(res.reason).toBe("exceeds-daily-allowance")
    // The client needs the number to say "you can top up $5", not just "no".
    expect(res.remainingAllowanceCents).toBe(500)
    expect(res.limitCents).toBe(10000)
  })

  it("allows spending the allowance down to exactly zero", async () => {
    mockSumPrior.mockResolvedValue(2000)
    const res = await authorize({ amountCents: 8000 })

    expect(res.authorized).toBe(true)
    expect(res.remainingAllowanceCents).toBe(0)
  })

  it("never authorises when the 24h history cannot be read", async () => {
    // Coercing an unreadable history to zero would hand every account its full
    // allowance again for the duration of an ERPNext outage.
    mockSumPrior.mockResolvedValue(new Error("erpnext down"))
    const res = await authorize()

    expect(res.authorized).toBe(false)
    expect(res.reason).toBe("history-unavailable")
    expect(mockSaveIntent).not.toHaveBeenCalled()
  })

  it("refuses when settings are unavailable", async () => {
    mockGetFygaroSettings.mockResolvedValue(undefined)
    const res = await authorize()

    expect(res.authorized).toBe(false)
    expect(res.reason).toBe("settings-unavailable")
  })

  it("refuses when auto-credit is off, rather than creating another stuck top-up", async () => {
    mockGetFygaroSettings.mockResolvedValue({ ...SETTINGS, autoCreditEnabled: false })
    const res = await authorize()

    expect(res.authorized).toBe(false)
    expect(res.reason).toBe("checkout-disabled")
  })

  it("refuses below the minimum, and says what the minimum is", async () => {
    const res = await authorize({ amountCents: 400 })

    expect(res.authorized).toBe(false)
    expect(res.reason).toBe("below-minimum")
    expect(res.minimumCents).toBe(500)
  })

  it("refuses above the single-payment auto-credit ceiling", async () => {
    // Within the daily allowance is not enough: a payment over the single-payment
    // ceiling is held for manual review, so authorising it would still strand funds.
    mockGetFygaroSettings.mockResolvedValue({
      ...SETTINGS,
      autoCreditLimit: 50,
      dailyTopupLimits: { 1: 1000 },
    })
    const res = await authorize({ amountCents: 8000 })

    expect(res.authorized).toBe(false)
    expect(res.reason).toBe("above-single-payment-limit")
    expect(res.limitCents).toBe(5000)
  })

  it("refuses a level with no configured daily limit", async () => {
    const res = await authorize({ level: 0 as AccountLevel })

    expect(res.authorized).toBe(false)
    expect(res.reason).toBe("no-daily-limit-for-level")
  })

  it("stays disabled until it is switched on", async () => {
    mockCheckoutConfig = { ...CHECKOUT, enabled: false }
    const res = await authorize()

    expect(res.authorized).toBe(false)
    expect(res.reason).toBe("checkout-disabled")
    // Nothing downstream should be touched while the feature is off.
    expect(mockGetFygaroSettings).not.toHaveBeenCalled()
  })

  it("refuses when the configured keyId has no signing secret", async () => {
    // Signing with a missing secret would produce a token Fygaro rejects, so the
    // customer would hit a dead end after we told them to pay.
    mockCheckoutConfig = { ...CHECKOUT, keyId: "key-absent" }
    const res = await authorize()

    expect(res.authorized).toBe(false)
    expect(res.reason).toBe("checkout-disabled")
  })

  it("still authorises when the intent could not be stored", async () => {
    // The signed amount and the webhook gate both still apply; only our own
    // after-the-fact cross-check is missing. A Redis blip must not block a
    // legitimate top-up.
    mockSaveIntent.mockResolvedValue(new Error("redis down"))
    const res = await authorize()

    expect(res.authorized).toBe(true)
    expect(res.checkout.url).toContain("?jwt=")
  })

  it("excludes nothing real from the prior-24h sum", async () => {
    // Nothing has been paid yet, so the exclusion must not match a live row —
    // an accidental match would under-count the customer's spend.
    await authorize()

    const [{ excludeTransactionId, accountId }] = mockSumPrior.mock.calls[0]
    expect(accountId).toBe("acct-1")
    expect(excludeTransactionId).toContain("acct-1")
    expect(excludeTransactionId).not.toBe("acct-1")
  })
})
