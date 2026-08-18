import { AccountLevel } from "@domain/accounts"

const mockGetFygaroSettings = jest.fn()
const mockReadWindow = jest.fn()

jest.mock("@services/fygaro/webhook-server/fygaro-settings", () => ({
  getFygaroSettings: (...args: unknown[]) => mockGetFygaroSettings(...args),
}))
jest.mock("@services/frappe/BridgeTransferRequestWriter", () => ({
  readFygaroTopupWindowLast24h: (...args: unknown[]) => mockReadWindow(...args),
}))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getFygaroTopupAllowance } = require("@app/fygaro/topup-allowance")

const SETTINGS = { dailyTopupLimits: { 1: 125, 2: 1000, 3: 2500 } }
const DAY_MS = 24 * 60 * 60 * 1000

const ask = (overrides: Record<string, unknown> = {}) =>
  getFygaroTopupAllowance({ accountId: "acct-1", level: AccountLevel.One, ...overrides })

beforeEach(() => {
  jest.clearAllMocks()
  mockGetFygaroSettings.mockResolvedValue({ ...SETTINGS })
  mockReadWindow.mockResolvedValue({ grossCents: 0 })
})

describe("getFygaroTopupAllowance", () => {
  it("reports the full limit when nothing has been spent", async () => {
    const res = await ask()

    expect(res.available).toBe(true)
    expect(res.allowance).toMatchObject({
      limitCents: 12500,
      spentCents: 0,
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
})
