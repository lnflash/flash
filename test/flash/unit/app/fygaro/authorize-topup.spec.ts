import { AccountLevel } from "@domain/accounts"
import { parseCustomReference } from "@services/fygaro/checkout"

const mockGetFygaroSettings = jest.fn()
const mockSumPrior = jest.fn()
const mockSaveIntent = jest.fn()
const mockSumOutstanding = jest.fn()
const mockReleaseReservation = jest.fn()
const mockGetFlashFeeDiscountPercent = jest.fn()

jest.mock("@services/fygaro/webhook-server/fygaro-settings", () => ({
  getFygaroSettings: (...args: unknown[]) => mockGetFygaroSettings(...args),
}))
jest.mock("@services/frappe/BridgeTransferRequestWriter", () => ({
  sumFygaroTopupGrossCentsLast24h: (...args: unknown[]) => mockSumPrior(...args),
}))
jest.mock("@services/frappe/fee-discounts", () => ({
  getFlashFeeDiscountPercent: (...args: unknown[]) =>
    mockGetFlashFeeDiscountPercent(...args),
}))
jest.mock("@services/fygaro/checkout-intent-store", () => ({
  newIntentId: () => "intent-fixed",
  saveIntent: (...args: unknown[]) => mockSaveIntent(...args),
  sumOutstandingAuthorizedCents: (...args: unknown[]) => mockSumOutstanding(...args),
  releaseIntentReservation: (...args: unknown[]) => mockReleaseReservation(...args),
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
      enabled: mockFygaroEnabled,
      credit: { enabled: mockCreditEnabled },
      checkout: mockCheckoutConfig,
      webhook: { secrets: { "key-1": "shared-secret" } },
    }
  },
}))

let mockCheckoutConfig: typeof CHECKOUT = { ...CHECKOUT }
let mockFygaroEnabled = true
let mockCreditEnabled = true

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { authorizeFygaroTopup } = require("@app/fygaro/authorize-topup")

// The same canonical operator settings the webhook spec uses, so the two sides
// of this feature are pinned against one fee ladder: 2.99% + $0.49 processor,
// 2.0% Flash margin. $5 minimum, $200 single-payment ceiling, $100/$500 daily.
const SETTINGS = {
  processor: "Fygaro",
  processorFeePercent: 2.99,
  processorFeeFixed: 0.49,
  flashMarginPercent: 2.0,
  flashMarginFixed: 0,
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
  mockFygaroEnabled = true
  mockCreditEnabled = true
  mockGetFygaroSettings.mockResolvedValue({ ...SETTINGS })
  mockSumPrior.mockResolvedValue(0)
  mockSumOutstanding.mockResolvedValue(0)
  mockSaveIntent.mockResolvedValue(true)
  mockGetFlashFeeDiscountPercent.mockResolvedValue(0)
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

  it("asks the trailing-24h sum for the whole window, with nothing excluded", async () => {
    // Nothing has been paid yet, so there is no row of this request's own to
    // exclude. The parameter is omitted rather than filled with a sentinel whose
    // correctness would rest on "this string can never collide with a real id".
    await authorize()

    const [args] = mockSumPrior.mock.calls[0]
    expect(args).toEqual({ accountId: "acct-1" })
    expect(args.excludeTransactionId).toBeUndefined()
  })

  describe("yaml master gates", () => {
    // The first rollout state is checkout ON, credit still OFF (credit.enabled
    // ships default-false). Minting links in that state charges the card and
    // records the payment with reason `credit-disabled` — charged and
    // uncredited, the 2026-08-16 incident reached through the very path that
    // was supposed to prevent it.
    it("refuses while fygaro.credit.enabled is off", async () => {
      mockCreditEnabled = false
      const res = await authorize()

      expect(res.authorized).toBe(false)
      expect(res.reason).toBe("checkout-disabled")
      expect(mockGetFygaroSettings).not.toHaveBeenCalled()
      expect(mockSaveIntent).not.toHaveBeenCalled()
    })

    it("refuses while fygaro.enabled is off", async () => {
      // Worse than credit-off: fygaroEnabledGuard 503s every webhook delivery,
      // so the payment is not even RECORDED.
      mockFygaroEnabled = false
      const res = await authorize()

      expect(res.authorized).toBe(false)
      expect(res.reason).toBe("checkout-disabled")
      expect(mockGetFygaroSettings).not.toHaveBeenCalled()
      expect(mockSaveIntent).not.toHaveBeenCalled()
    })
  })

  describe("outstanding authorisations count against the allowance", () => {
    it("refuses a second full-allowance link while the first is still live", async () => {
      // Authorisation is not reservation unless live links are subtracted:
      // otherwise N calls against a $100 allowance each mint a $100 link, and
      // paying two of them captures $200 while the webhook credits one.
      mockSumOutstanding.mockResolvedValue(8000)
      const res = await authorize({ amountCents: 8000 })

      expect(res.authorized).toBe(false)
      expect(res.reason).toBe("exceeds-daily-allowance")
      expect(res.remainingAllowanceCents).toBe(2000)
      expect(mockSaveIntent).not.toHaveBeenCalled()
    })

    it("counts outstanding links alongside settled charges", async () => {
      // $30 settled + $30 authorised-but-unpaid = $60 of a $100 allowance.
      mockSumPrior.mockResolvedValue(3000)
      mockSumOutstanding.mockResolvedValue(3000)
      const res = await authorize({ amountCents: 3000 })

      expect(res.authorized).toBe(true)
      expect(res.remainingAllowanceCents).toBe(1000)
    })

    it("never treats an unreadable reservation index as nothing outstanding", async () => {
      // Failing open here is exactly the hole: "no live links" is what lets a
      // second full-allowance link be minted.
      mockSumOutstanding.mockResolvedValue(new Error("redis down"))
      const res = await authorize()

      expect(res.authorized).toBe(false)
      expect(res.reason).toBe("history-unavailable")
      expect(mockSaveIntent).not.toHaveBeenCalled()
    })

    it("rolls the reservation back when a racing request got in between", async () => {
      // Both requests passed the check, both reserved; the re-read now shows the
      // combined total, so this one backs out rather than over-issuing.
      mockSumOutstanding.mockResolvedValueOnce(0).mockResolvedValueOnce(16000)
      const res = await authorize({ amountCents: 8000 })

      expect(res.authorized).toBe(false)
      expect(res.reason).toBe("exceeds-daily-allowance")
      expect(mockReleaseReservation).toHaveBeenCalledWith(
        expect.objectContaining({ intentId: "intent-fixed", accountId: "acct-1" }),
      )
    })

    it("keeps the reservation when the re-read still fits", async () => {
      mockSumOutstanding.mockResolvedValueOnce(0).mockResolvedValueOnce(8000)
      const res = await authorize({ amountCents: 8000 })

      expect(res.authorized).toBe(true)
      expect(mockReleaseReservation).not.toHaveBeenCalled()
    })
  })

  describe("one gate function, no drift", () => {
    it("refuses an above-minimum amount whose fees sink the net to zero", async () => {
      // The gate the webhook runs has a `non-positive-net` stop. A pre-charge
      // check that skipped it would authorise this and the webhook would refuse
      // it: charged, uncredited.
      mockGetFygaroSettings.mockResolvedValue({
        ...SETTINGS,
        processorFeeFixed: 100, // $100 fixed against a $10 top-up
      })
      const res = await authorize({ amountCents: 1000 })

      expect(res.authorized).toBe(false)
      expect(res.reason).toBe("non-positive-net")
      expect(mockSaveIntent).not.toHaveBeenCalled()
    })

    it("applies the account's Flash-fee discount to the same net the webhook will compute", async () => {
      mockGetFlashFeeDiscountPercent.mockResolvedValue(100)
      const res = await authorize()

      expect(mockGetFlashFeeDiscountPercent).toHaveBeenCalledWith({
        username: "jaceth2009",
        flow: "topup",
      })
      expect(res.authorized).toBe(true)
    })

    it("does not read ERPNext history for a stop that precedes it", async () => {
      // A client can otherwise make us run a list query per rejected amount.
      const res = await authorize({ amountCents: 50_000 })

      expect(res.authorized).toBe(false)
      expect(res.reason).toBe("above-single-payment-limit")
      expect(mockSumPrior).not.toHaveBeenCalled()
      expect(mockSumOutstanding).not.toHaveBeenCalled()
    })
  })
})
