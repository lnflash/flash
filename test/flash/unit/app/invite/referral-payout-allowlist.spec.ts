/**
 * The ERPNext Referral Payout Allowlist reader. Polarity IS the feature: an
 * account is allowlisted only on a readable, enabled, well-formed row. An
 * unreadable, missing, or malformed allowlist must read as "nobody", never
 * as "everybody" (unlike the fail-open fee-discounts reader it resembles).
 */
const mockGetAllowlist = jest.fn()
const mockErpNext: { getReferralPayoutAllowlist?: (...a: unknown[]) => unknown } = {
  getReferralPayoutAllowlist: (...a: unknown[]) => mockGetAllowlist(...a),
}
jest.mock("@services/frappe/ErpNext", () => ({
  __esModule: true,
  get default() {
    return mockErpNext
  },
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}))

import {
  accountAllowlistedForReferralPayout,
  referralPayoutAllowlistIsEmpty,
  resetReferralPayoutAllowlistCache,
  validateReferralPayoutAllowlistDoc,
} from "@app/invite/referral-payout-allowlist"
import { ReferralPayoutAllowlistQueryError } from "@services/frappe/errors"
import { baseLogger } from "@services/logger"

const ACCT_A = "64b7f0c2a1b2c3d4e5f60718" as AccountId
const ACCT_B = "64b7f0c2a1b2c3d4e5f60719" as AccountId
const ACCT_C = "64b7f0c2a1b2c3d4e5f6071a" as AccountId

const row = (account_id: unknown, enabled: unknown = 1) => ({ account_id, enabled })

const realGetAllowlist = mockErpNext.getReferralPayoutAllowlist

beforeEach(() => {
  jest.clearAllMocks()
  jest.useRealTimers()
  mockErpNext.getReferralPayoutAllowlist = realGetAllowlist
  resetReferralPayoutAllowlistCache()
})

describe("validateReferralPayoutAllowlistDoc", () => {
  it("returns the account id of an enabled, well-formed row", () => {
    expect(validateReferralPayoutAllowlistDoc(row(ACCT_A))).toBe(ACCT_A)
  })

  it("trims and lowercases the account id", () => {
    expect(validateReferralPayoutAllowlistDoc(row(`  ${ACCT_A.toUpperCase()} `))).toBe(
      ACCT_A,
    )
  })

  it.each([
    ["enabled: 0", row(ACCT_A, 0)],
    ['enabled: "0"', row(ACCT_A, "0")],
    ["enabled: false", row(ACCT_A, false)],
    ["enabled missing", { account_id: ACCT_A }],
    ["blank account_id", row("")],
    ["account_id missing", { enabled: 1 }],
    ["account_id too short", row("64b7f0c2a1b2c3d4e5f607")],
    ["account_id not hex", row("zzb7f0c2a1b2c3d4e5f60718")],
    ["account_id a username", row("civilizedbarbarian")],
    ["account_id a UUID", row("6b1c0e8e-5c3f-4c1e-9f6e-2a1b3c4d5e6f")],
    ["account_id a number", row(12345)],
    ["null doc", null],
    ["string doc", "64b7f0c2a1b2c3d4e5f60718"],
  ])("drops the row when %s", (_label, doc) => {
    expect(validateReferralPayoutAllowlistDoc(doc)).toBeUndefined()
  })
})

describe("accountAllowlistedForReferralPayout", () => {
  it("is true for an account on an enabled row", async () => {
    mockGetAllowlist.mockResolvedValue([row(ACCT_A)])

    await expect(accountAllowlistedForReferralPayout(ACCT_A)).resolves.toBe(true)
  })

  it("is false for a different account", async () => {
    mockGetAllowlist.mockResolvedValue([row(ACCT_A)])

    await expect(accountAllowlistedForReferralPayout(ACCT_B)).resolves.toBe(false)
  })

  it("matches regardless of the case the row was stored in", async () => {
    mockGetAllowlist.mockResolvedValue([row(ACCT_A.toUpperCase())])

    await expect(accountAllowlistedForReferralPayout(ACCT_A)).resolves.toBe(true)
  })

  it("drops disabled and malformed rows (even if the ERP filter is lost) but keeps the rest", async () => {
    mockGetAllowlist.mockResolvedValue([
      row(ACCT_A, 0),
      row(ACCT_B, "0"),
      row("not-an-account-id"),
      null,
      row(ACCT_C),
    ])

    await expect(accountAllowlistedForReferralPayout(ACCT_A)).resolves.toBe(false)
    await expect(accountAllowlistedForReferralPayout(ACCT_B)).resolves.toBe(false)
    await expect(accountAllowlistedForReferralPayout(ACCT_C)).resolves.toBe(true)
    expect(baseLogger.warn).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("dropping"),
    )
  })

  it("fails CLOSED on an ERP read error, and warns", async () => {
    mockGetAllowlist.mockResolvedValue(new ReferralPayoutAllowlistQueryError("erp down"))

    await expect(accountAllowlistedForReferralPayout(ACCT_A)).resolves.toBe(false)
    expect(baseLogger.warn).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("EMPTY"),
    )
  })

  it("fails CLOSED when the ERP response is not an array", async () => {
    mockGetAllowlist.mockResolvedValue({ account_id: ACCT_A, enabled: 1 })

    await expect(accountAllowlistedForReferralPayout(ACCT_A)).resolves.toBe(false)
  })

  it("fails CLOSED when the ERP client throws, and never throws itself", async () => {
    mockGetAllowlist.mockRejectedValue(new Error("boom"))

    await expect(accountAllowlistedForReferralPayout(ACCT_A)).resolves.toBe(false)
  })

  it("fails CLOSED when the ErpNext client has no allowlist method", async () => {
    mockErpNext.getReferralPayoutAllowlist = undefined

    await expect(accountAllowlistedForReferralPayout(ACCT_A)).resolves.toBe(false)
  })

  it("memoises for the TTL: a KYC burst is one ERP read", async () => {
    mockGetAllowlist.mockResolvedValue([row(ACCT_A)])

    await accountAllowlistedForReferralPayout(ACCT_A)
    await accountAllowlistedForReferralPayout(ACCT_B)
    await referralPayoutAllowlistIsEmpty()

    expect(mockGetAllowlist).toHaveBeenCalledTimes(1)
  })

  it("caches failures too, so an ERP outage cannot become a retry storm", async () => {
    mockGetAllowlist.mockResolvedValue(new ReferralPayoutAllowlistQueryError("erp down"))

    await accountAllowlistedForReferralPayout(ACCT_A)
    await accountAllowlistedForReferralPayout(ACCT_A)

    expect(mockGetAllowlist).toHaveBeenCalledTimes(1)
  })

  it("stops matching a removed row once the 60s TTL lapses", async () => {
    jest.useFakeTimers({ now: new Date("2026-10-10T00:00:00Z") })
    mockGetAllowlist.mockResolvedValueOnce([row(ACCT_A)]).mockResolvedValueOnce([])

    await expect(accountAllowlistedForReferralPayout(ACCT_A)).resolves.toBe(true)

    jest.setSystemTime(new Date("2026-10-10T00:00:59Z"))
    await expect(accountAllowlistedForReferralPayout(ACCT_A)).resolves.toBe(true)

    jest.setSystemTime(new Date("2026-10-10T00:01:00Z"))
    await expect(accountAllowlistedForReferralPayout(ACCT_A)).resolves.toBe(false)
    expect(mockGetAllowlist).toHaveBeenCalledTimes(2)
  })
})

describe("referralPayoutAllowlistIsEmpty", () => {
  it("is true when no rows are enabled", async () => {
    mockGetAllowlist.mockResolvedValue([])

    await expect(referralPayoutAllowlistIsEmpty()).resolves.toBe(true)
  })

  it("is true when every row is malformed or disabled", async () => {
    mockGetAllowlist.mockResolvedValue([row(ACCT_A, 0), row("bad")])

    await expect(referralPayoutAllowlistIsEmpty()).resolves.toBe(true)
  })

  it("is false when at least one valid row is enabled", async () => {
    mockGetAllowlist.mockResolvedValue([row(ACCT_A)])

    await expect(referralPayoutAllowlistIsEmpty()).resolves.toBe(false)
  })

  it("is true (fail closed) on an ERP read error", async () => {
    mockGetAllowlist.mockResolvedValue(new ReferralPayoutAllowlistQueryError("erp down"))

    await expect(referralPayoutAllowlistIsEmpty()).resolves.toBe(true)
  })
})
