import { AccountLevel } from "@domain/accounts"
import { parseCustomReference } from "@services/fygaro/checkout"
import { FygaroReservationWriteError } from "@services/fygaro/errors"

const mockGetFygaroSettings = jest.fn()
const mockSumPrior = jest.fn()
const mockSaveIntent = jest.fn()
const mockReadReservations = jest.fn()
const mockReadIntent = jest.fn()
const mockReleaseReservation = jest.fn()
const mockGetFlashFeeDiscountPercent = jest.fn()
const mockAlertBridge = jest.fn()

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
jest.mock("@services/alerts", () => ({
  alertBridge: (...args: unknown[]) => mockAlertBridge(...args),
  // The REAL key generator: the static-per-reason key selection is exactly what
  // makes an outage one incident per failing dependency instead of one page per
  // refused customer (or, before this, zero), so stubbing it would let a
  // regression pass.
  generateDedupKey: jest.requireActual("@services/alerts/dedup-key").generateDedupKey,
}))
jest.mock("@services/fygaro/checkout-intent-store", () => ({
  newIntentId: () => "intent-fixed",
  saveIntent: (...args: unknown[]) => mockSaveIntent(...args),
  readOutstandingReservations: (...args: unknown[]) => mockReadReservations(...args),
  readIntent: (...args: unknown[]) => mockReadIntent(...args),
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

const NOW_MS = 1_700_000_000_000

const authorize = (overrides: Record<string, unknown> = {}) =>
  authorizeFygaroTopup({
    accountId: "acct-1",
    username: "jaceth2009",
    level: AccountLevel.One,
    amountCents: 8000,
    nowMs: NOW_MS,
    ...overrides,
  })

// One live, unpaid link the account is holding. `expiresAtMs` is the zset score
// — the moment the JWT stops being payable and the hold stops counting.
const hold = (amountCents: number, intentId = "intent-open", expiresInMs = 900_000) => ({
  intentId,
  amountCents,
  expiresAtMs: NOW_MS + expiresInMs,
})

beforeEach(() => {
  jest.clearAllMocks()
  mockCheckoutConfig = { ...CHECKOUT }
  mockFygaroEnabled = true
  mockCreditEnabled = true
  mockGetFygaroSettings.mockResolvedValue({ ...SETTINGS })
  mockSumPrior.mockResolvedValue(0)
  mockReadReservations.mockResolvedValue([])
  mockReadIntent.mockResolvedValue({ found: false })
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

  it("stores the signed link itself, so an abandoned checkout can be re-offered", async () => {
    // Without the URL on the record there is no way out of a self-inflicted
    // hold: the client cannot cancel it and cannot be given it back.
    const res = await authorize()

    const [{ intent }] = mockSaveIntent.mock.calls[0]
    expect(intent.checkoutUrl).toBe(res.checkout.url)
    expect(intent.expiresAtMs).toBe(res.checkout.expiresAt.getTime())
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

  it("still authorises when only the cross-check record could not be stored", async () => {
    // The hold IS in place and the webhook gate still applies; only our own
    // after-the-fact verification is missing. That must not block a legitimate
    // top-up.
    mockSaveIntent.mockResolvedValue(new Error("redis down"))
    const res = await authorize()

    expect(res.authorized).toBe(true)
    expect(res.checkout.url).toContain("?jwt=")
  })

  it("refuses — and pages — when the RESERVATION could not be written", async () => {
    // The read side of the reservation index fails closed. If the write side
    // failed open, the hold would be invisible to the next request and the same
    // allowance would be handed out twice: exactly the over-issue the
    // reservation exists to stop.
    mockSaveIntent.mockResolvedValue(new FygaroReservationWriteError("READONLY"))
    const res = await authorize()

    expect(res.authorized).toBe(false)
    expect(res.reason).toBe("reservations-unavailable")
    // Card top-ups being 100% unavailable must never be silent.
    expect(mockAlertBridge).toHaveBeenCalledTimes(1)
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
    it("refuses a second link for a DIFFERENT amount while the first is still live", async () => {
      // Authorisation is not reservation unless live links are subtracted:
      // otherwise N calls against a $100 allowance each mint a $100 link, and
      // paying two of them captures $200 while the webhook credits one.
      mockReadReservations.mockResolvedValue([hold(8000)])
      const res = await authorize({ amountCents: 5000 })

      expect(res.authorized).toBe(false)
      expect(res.remainingAllowanceCents).toBe(2000)
      expect(mockSaveIntent).not.toHaveBeenCalled()
    })

    it("counts outstanding links alongside settled charges", async () => {
      // $30 settled + $30 authorised-but-unpaid = $60 of a $100 allowance.
      mockSumPrior.mockResolvedValue(3000)
      mockReadReservations.mockResolvedValue([hold(3000)])
      const res = await authorize({ amountCents: 3000 })

      expect(res.authorized).toBe(true)
      expect(res.remainingAllowanceCents).toBe(1000)
    })

    it("never treats an unreadable reservation index as nothing outstanding", async () => {
      // Failing open here is exactly the hole: "no live links" is what lets a
      // second full-allowance link be minted.
      mockReadReservations.mockResolvedValue(new Error("redis down"))
      const res = await authorize()

      expect(res.authorized).toBe(false)
      // NOT `history-unavailable`: that name sends whoever reads the alert to
      // ERPNext for a fault that is in Redis.
      expect(res.reason).toBe("reservations-unavailable")
      expect(mockSaveIntent).not.toHaveBeenCalled()
    })

    it("rolls the reservation back when a racing request got in between", async () => {
      // Both requests passed the check, both reserved; the re-read now shows the
      // combined total, so this one backs out rather than over-issuing.
      mockReadReservations
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([hold(8000, "intent-racer"), hold(8000, "intent-fixed")])
      const res = await authorize({ amountCents: 8000 })

      expect(res.authorized).toBe(false)
      expect(res.reason).toBe("exceeds-daily-allowance")
      expect(mockReleaseReservation).toHaveBeenCalledWith(
        expect.objectContaining({ intentId: "intent-fixed", accountId: "acct-1" }),
      )
      // The number reported must come from the RE-READ, minus this request's own
      // reservation (just released). Reporting the pre-race $100 would hand the
      // client a bigger number than reality in exactly the case where it is
      // wrong — it retries the same amount and fails again.
      expect(res.remainingAllowanceCents).toBe(2000)
    })

    it("keeps the reservation when the re-read still fits", async () => {
      mockReadReservations
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([hold(8000, "intent-fixed")])
      const res = await authorize({ amountCents: 8000 })

      expect(res.authorized).toBe(true)
      expect(mockReleaseReservation).not.toHaveBeenCalled()
    })
  })

  // The single most common thing a payer does is open a payment page and walk
  // away from it. Before this, that self-inflicted hold was reported as
  // "exceeds-daily-allowance" with "$0.00 left" — to an account that had spent
  // nothing — and there was no way for the client to clear its own hold.
  describe("an abandoned checkout is not a spent allowance", () => {
    const OPEN_URL = "https://fygaro.com/en/pb/ABC123?jwt=open.link.signature"
    const openIntent = (overrides: Record<string, unknown> = {}) => ({
      found: true,
      intent: {
        intentId: "intent-open",
        accountId: "acct-1",
        username: "jaceth2009",
        amountCents: 10000,
        currency: "USD",
        createdAtMs: NOW_MS - 60_000,
        checkoutUrl: OPEN_URL,
        expiresAtMs: NOW_MS + 840_000,
        ...overrides,
      },
    })

    it("hands the SAME live link back when the customer retries the same amount", async () => {
      // $100 cap, $0 settled, one live $100 link: the customer is asking for the
      // link they already have. Refusing them for their own reservation with
      // "you have $0.00 left" is both false and a dead end.
      mockReadReservations.mockResolvedValue([hold(10000)])
      mockReadIntent.mockResolvedValue(openIntent())
      const res = await authorize({ amountCents: 10000 })

      expect(res.authorized).toBe(true)
      expect(res.reused).toBe(true)
      expect(res.checkout.url).toBe(OPEN_URL)
      // Nothing new is minted or reserved — the outstanding total must not move.
      expect(mockSaveIntent).not.toHaveBeenCalled()
      expect(res.remainingAllowanceCents).toBe(0)
    })

    it("refuses with checkout-already-open, not exceeds-daily-allowance, when it cannot re-offer", async () => {
      // A different amount: the hold still blocks it, but the account has spent
      // $0.00 today, so "you have $0.00 left of today's top-up limit" would be a
      // false statement about a limit it never reached.
      mockReadReservations.mockResolvedValue([hold(10000)])
      const res = await authorize({ amountCents: 5000 })

      expect(res.authorized).toBe(false)
      expect(res.reason).toBe("checkout-already-open")
      expect(res.holdExpiresAt).toEqual(new Date(NOW_MS + 900_000))
      expect(res.holdAmountCents).toBe(10000)
    })

    it("never hands back a link whose record names a different account", async () => {
      // The id came out of THIS account's reservation index, so a record naming
      // someone else means the two disagree — and the link is not ours to give.
      mockReadReservations.mockResolvedValue([hold(10000)])
      mockReadIntent.mockResolvedValue(openIntent({ accountId: "acct-someone-else" }))
      const res = await authorize({ amountCents: 10000 })

      expect(res.authorized).toBe(false)
      expect(res.reason).toBe("checkout-already-open")
    })

    it("refuses an intent record written before the URL was stored", async () => {
      // Records already in Redis when this shipped have no checkoutUrl, so they
      // cannot be re-offered — but the refusal must still be the honest one.
      mockReadReservations.mockResolvedValue([hold(10000)])
      mockReadIntent.mockResolvedValue(
        openIntent({ checkoutUrl: undefined, expiresAtMs: undefined }),
      )
      const res = await authorize({ amountCents: 10000 })

      expect(res.authorized).toBe(false)
      expect(res.reason).toBe("checkout-already-open")
    })

    it("names the SOONEST hold to lift, since that is when allowance reappears", async () => {
      mockReadReservations.mockResolvedValue([
        hold(6000, "intent-late", 800_000),
        hold(4000, "intent-soon", 120_000),
      ])
      const res = await authorize({ amountCents: 5000 })

      expect(res.reason).toBe("checkout-already-open")
      expect(res.holdExpiresAt).toEqual(new Date(NOW_MS + 120_000))
      expect(res.holdAmountCents).toBe(4000)
    })

    it("still says exceeds-daily-allowance when the SETTLED spend is what blocks it", async () => {
      // $95 already charged today against a $100 cap. The holds are irrelevant:
      // this account really has spent its allowance, and saying so is correct.
      mockSumPrior.mockResolvedValue(9500)
      mockReadReservations.mockResolvedValue([hold(1000)])
      const res = await authorize({ amountCents: 8000 })

      expect(res.authorized).toBe(false)
      expect(res.reason).toBe("exceeds-daily-allowance")
    })
  })

  // The webhook side pages on both of its transient stops. This side had no
  // signal at all, so card top-ups could be 100% unavailable for every user
  // while nothing fired.
  describe("a broken pre-charge check is an incident, not a silence", () => {
    it.each([
      ["settings-unavailable", () => mockGetFygaroSettings.mockResolvedValue(undefined)],
      [
        "history-unavailable",
        () => mockSumPrior.mockResolvedValue(new Error("erpnext down")),
      ],
      [
        "reservations-unavailable",
        () => mockReadReservations.mockResolvedValue(new Error("redis down")),
      ],
    ])("pages once, naming %s, when the check cannot run", async (reason, arrange) => {
      arrange()
      const res = await authorize()

      expect(res.authorized).toBe(false)
      expect(res.reason).toBe(reason)
      expect(mockAlertBridge).toHaveBeenCalledTimes(1)
      expect(mockAlertBridge).toHaveBeenCalledWith(
        expect.objectContaining({
          severity: "warning",
          // Static per reason: an outage collapses to ONE incident per failing
          // dependency rather than one page per refused customer, and Redis
          // never lands in the same incident as ERPNext.
          dedupKey: `fygaro:authorize-unavailable:${reason}`,
          context: expect.objectContaining({ reason }),
        }),
      )
    })

    it("never pages for a refusal the customer caused", async () => {
      mockSumPrior.mockResolvedValue(9500)
      const res = await authorize({ amountCents: 8000 })

      expect(res.reason).toBe("exceeds-daily-allowance")
      expect(mockAlertBridge).not.toHaveBeenCalled()
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
      expect(mockReadReservations).not.toHaveBeenCalled()
    })
  })
})
