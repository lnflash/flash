import { AccountLevel } from "@domain/accounts"

const mockGetFygaroSettings = jest.fn()
const mockReadWindow = jest.fn()
const mockReadOutstandingReservations = jest.fn()

// A fully-wired deploy: every switch the shared master gate checks, not just
// the two this query used to check for itself.
const CHECKOUT = {
  enabled: true,
  buttonUrl: "https://fygaro.com/en/pb/ABC123",
  keyId: "key-1",
  ttlSeconds: 900,
}

const mockFygaroConfig: {
  enabled: boolean
  credit: { enabled: boolean }
  checkout: typeof CHECKOUT
  webhook: { secrets: Record<string, string> }
} = {
  enabled: true,
  credit: { enabled: true },
  checkout: { ...CHECKOUT },
  webhook: { secrets: { "key-1": "shared-secret" } },
}

jest.mock("@config", () => ({
  get FygaroConfig() {
    return mockFygaroConfig
  },
}))
jest.mock("@services/fygaro/webhook-server/fygaro-settings", () => ({
  getFygaroSettings: (...args: unknown[]) => mockGetFygaroSettings(...args),
}))
jest.mock("@services/frappe/BridgeTransferRequestWriter", () => ({
  readFygaroTopupWindowLast24h: (...args: unknown[]) => mockReadWindow(...args),
}))
jest.mock("@services/fygaro/checkout-intent-store", () => ({
  readOutstandingReservations: (...args: unknown[]) =>
    mockReadOutstandingReservations(...args),
}))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getFygaroTopupAllowance } = require("@app/fygaro/topup-allowance")

const SETTINGS = {
  dailyTopupLimits: { 1: 125, 2: 1000, 3: 2500 },
  autoCreditEnabled: true,
}
const DAY_MS = 24 * 60 * 60 * 1000
const NOW_MS = 1_787_000_000_000

const ask = (overrides: Record<string, unknown> = {}) =>
  getFygaroTopupAllowance({
    accountId: "acct-1",
    level: AccountLevel.One,
    nowMs: NOW_MS,
    ...overrides,
  })

beforeEach(() => {
  jest.clearAllMocks()
  mockFygaroConfig.enabled = true
  mockFygaroConfig.credit = { enabled: true }
  mockFygaroConfig.checkout = { ...CHECKOUT }
  mockFygaroConfig.webhook = { secrets: { "key-1": "shared-secret" } }
  mockGetFygaroSettings.mockResolvedValue({ ...SETTINGS })
  mockReadWindow.mockResolvedValue({ grossCents: 0 })
  mockReadOutstandingReservations.mockResolvedValue([])
})

describe("getFygaroTopupAllowance", () => {
  it("reports the full limit when nothing has been spent", async () => {
    const res = await ask()

    expect(res.available).toBe(true)
    expect(res.allowance).toMatchObject({
      limitCents: 12500,
      spentCents: 0,
      heldCents: 0,
      remainingCents: 12500,
    })
    // Nothing counted means nothing to wait for.
    expect(res.allowance.resetsAt).toBeUndefined()
  })

  it("subtracts what has already been spent", async () => {
    mockReadWindow.mockResolvedValue({ grossCents: 10000 })

    expect((await ask()).allowance).toMatchObject({
      spentCents: 10000,
      remainingCents: 2500,
    })
  })

  it("never reports a negative remainder", async () => {
    // Over-cap is reachable: a hand-credit, or spend recorded before a limit
    // change. "You have -$75 left" is not a thing to show anyone.
    mockReadWindow.mockResolvedValue({ grossCents: 20000 })

    expect((await ask()).allowance.remainingCents).toBe(0)
  })

  it("says when the allowance frees up, from the OLDEST counted payment", async () => {
    // The oldest is what rolls off first, so it is the soonest moment more
    // allowance exists — the only useful answer to "when can I try again".
    const oldest = Date.parse("2026-08-17T02:33:31Z")
    mockReadWindow.mockResolvedValue({ grossCents: 8000, oldestCountedMs: oldest })

    expect((await ask()).allowance.resetsAt.getTime()).toBe(oldest + DAY_MS)
  })

  it("refuses to guess when the history is unreadable", async () => {
    // Treating an ERPNext outage as zero spend would show every customer their
    // full allowance and then refuse the payment they were just invited to make.
    mockReadWindow.mockResolvedValue(new Error("erpnext down"))
    const res = await ask()

    expect(res.available).toBe(false)
    expect(res.reason).toBe("history-unavailable")
  })

  it("refuses when settings are unavailable", async () => {
    mockGetFygaroSettings.mockResolvedValue(undefined)
    const res = await ask()

    expect(res.available).toBe(false)
    expect(res.reason).toBe("settings-unavailable")
    expect(mockReadWindow).not.toHaveBeenCalled()
  })

  it("distinguishes a level with no configured limit from an outage", async () => {
    // Deterministic and permanent until the account upgrades — telling this
    // customer to try again later would be a lie they could act on forever.
    const res = await ask({ level: 0 as AccountLevel })

    expect(res.available).toBe(false)
    expect(res.reason).toBe("no-daily-limit-for-level")
  })

  it("reads the window WITHOUT excluding anything", async () => {
    // The exclusion exists for the webhook, which must drop its own in-flight
    // row. Nothing has been paid here, so excluding anything would under-count.
    await ask()

    expect(mockReadWindow).toHaveBeenCalledWith({ accountId: "acct-1" })
  })

  it("uses the limit for the caller's own level", async () => {
    expect((await ask({ level: AccountLevel.Two })).allowance.limitCents).toBe(100000)
  })

  // The gate that actually decides subtracts open checkout links
  // (authorize-topup: spent = prior + outstanding). A query that does not is a
  // query that invites a top-up the charge path then refuses — the exact
  // invite-then-refuse failure this feature exists to end, on a new surface.
  describe("open checkout links this account is still holding", () => {
    it("subtracts an abandoned link from what would be accepted right now", async () => {
      // The canonical case: mint a $60 link, close the page. Nothing is charged
      // and no ERPNext row exists, so a naive query reports the full $125 — the
      // customer enters $125 and fygaroCheckoutCreate refuses them.
      mockReadOutstandingReservations.mockResolvedValue([
        { intentId: "intent-1", amountCents: 6000, expiresAtMs: NOW_MS + 900_000 },
      ])

      expect((await ask()).allowance).toMatchObject({
        limitCents: 12500,
        // Nothing has been CHARGED. Folding the hold into "spent" would be its
        // own false claim; the hold is reported on its own line.
        spentCents: 0,
        heldCents: 6000,
        remainingCents: 6500,
        // ...and the hold lifts on its own when the JWT expires, which is the
        // only actionable thing to say about it. `resetsAt` cannot carry this:
        // it is derived from the ERPNext window and there is no row here at all.
        holdsExpireAt: new Date(NOW_MS + 900_000),
      })
      expect((await ask()).allowance.resetsAt).toBeUndefined()
    })

    it("reports the SOONEST hold expiry, not the latest", async () => {
      // The first moment any of this allowance comes back on its own. Reporting
      // the latest would tell a customer to wait longer than they have to.
      mockReadOutstandingReservations.mockResolvedValue([
        { intentId: "intent-1", amountCents: 2000, expiresAtMs: NOW_MS + 900_000 },
        { intentId: "intent-2", amountCents: 1000, expiresAtMs: NOW_MS + 120_000 },
        { intentId: "intent-3", amountCents: 1000, expiresAtMs: NOW_MS + 600_000 },
      ])

      expect((await ask()).allowance.holdsExpireAt).toEqual(new Date(NOW_MS + 120_000))
    })

    it("reports no hold expiry when nothing is held", async () => {
      expect((await ask()).allowance.holdsExpireAt).toBeUndefined()
    })

    it("subtracts holds and settled spend together, exactly as the gate does", async () => {
      mockReadWindow.mockResolvedValue({ grossCents: 5000 })
      mockReadOutstandingReservations.mockResolvedValue([
        { intentId: "intent-1", amountCents: 4000, expiresAtMs: NOW_MS + 900_000 },
        { intentId: "intent-2", amountCents: 1000, expiresAtMs: NOW_MS + 900_000 },
      ])

      expect((await ask()).allowance).toMatchObject({
        spentCents: 5000,
        heldCents: 5000,
        remainingCents: 2500,
      })
    })

    it("never reports a negative remainder once holds are counted", async () => {
      mockReadWindow.mockResolvedValue({ grossCents: 10000 })
      mockReadOutstandingReservations.mockResolvedValue([
        { intentId: "intent-1", amountCents: 6000, expiresAtMs: NOW_MS + 900_000 },
      ])

      expect((await ask()).allowance.remainingCents).toBe(0)
    })

    it("prunes expired holds through the same clock the gate uses", async () => {
      await ask()

      expect(mockReadOutstandingReservations).toHaveBeenCalledWith({
        accountId: "acct-1",
        nowMs: NOW_MS,
      })
    })

    it("fails CLOSED, and names Redis, when the hold index is unreadable", async () => {
      // Unknown outstanding is not zero outstanding — the same posture
      // authorize-topup takes. And the reason must not say "history", or the
      // operator reading it goes hunting through ERPNext for a Redis fault.
      mockReadOutstandingReservations.mockResolvedValue(new Error("redis down"))
      const res = await ask()

      expect(res.available).toBe(false)
      expect(res.reason).toBe("reservations-unavailable")
    })
  })

  // Same argument as the reservations gap, on the master switches: with either
  // off, fygaroCheckoutCreate refuses EVERY request with `checkout-disabled`,
  // so any number reported here is a number that cannot be spent.
  describe("the master switches", () => {
    it("reports nothing when card top-ups are off at the deploy level", async () => {
      mockFygaroConfig.enabled = false
      const res = await ask()

      expect(res.available).toBe(false)
      expect(res.reason).toBe("checkout-disabled")
    })

    it("reports nothing when crediting is off at the deploy level", async () => {
      mockFygaroConfig.credit = { enabled: false }
      const res = await ask()

      expect(res.available).toBe(false)
      expect(res.reason).toBe("checkout-disabled")
      // Checked before any read: an allowance nobody can spend is not worth an
      // ERPNext list query per screen render.
      expect(mockGetFygaroSettings).not.toHaveBeenCalled()
      expect(mockReadWindow).not.toHaveBeenCalled()
    })

    it("reports nothing when the operator kill switch is off", async () => {
      mockGetFygaroSettings.mockResolvedValue({ ...SETTINGS, autoCreditEnabled: false })
      const res = await ask()

      expect(res.available).toBe(false)
      expect(res.reason).toBe("checkout-disabled")
      expect(mockReadWindow).not.toHaveBeenCalled()
    })

    // The half this query used to skip. `fygaro.checkout.enabled` DEFAULTS TO
    // FALSE and is independent of the two switches above, so in the default
    // rollout state this query reported a healthy allowance while
    // fygaroCheckoutCreate refused every single request with
    // `checkout-disabled` — invite-then-refuse, rebuilt on the surface added to
    // end it. Both sides now run one shared predicate, so a gate cannot be
    // added to one and forgotten on the other.
    it("reports nothing when server-signed checkout itself is off", async () => {
      mockFygaroConfig.checkout = { ...CHECKOUT, enabled: false }
      const res = await ask()

      expect(res.available).toBe(false)
      expect(res.reason).toBe("checkout-disabled")
      expect(mockGetFygaroSettings).not.toHaveBeenCalled()
      expect(mockReadWindow).not.toHaveBeenCalled()
    })

    it("reports nothing when no payment-button URL is configured", async () => {
      mockFygaroConfig.checkout = { ...CHECKOUT, buttonUrl: "" }
      const res = await ask()

      expect(res.available).toBe(false)
      expect(res.reason).toBe("checkout-disabled")
    })

    it("reports nothing when no signing key id is configured", async () => {
      mockFygaroConfig.checkout = { ...CHECKOUT, keyId: "" }
      const res = await ask()

      expect(res.available).toBe(false)
      expect(res.reason).toBe("checkout-disabled")
    })

    it("reports nothing when the key id names a secret we do not have", async () => {
      // Misconfiguration on our side: no link can be SIGNED, so no amount can
      // be spent, so there is no allowance worth reporting.
      mockFygaroConfig.webhook = { secrets: {} }
      const res = await ask()

      expect(res.available).toBe(false)
      expect(res.reason).toBe("checkout-disabled")
      expect(mockReadWindow).not.toHaveBeenCalled()
    })
  })
})
