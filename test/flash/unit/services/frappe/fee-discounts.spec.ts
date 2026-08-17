jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock("@services/frappe/ErpNext", () => ({
  __esModule: true,
  default: { getFeeDiscounts: (...args: unknown[]) => mockGetFeeDiscounts(...args) },
}))

const mockGetFeeDiscounts = jest.fn()

import { FeeDiscountQueryError } from "@services/frappe/errors"
import {
  getFlashFeeDiscountPercent,
  validateFeeDiscountDoc,
  _resetFeeDiscountsCache,
} from "@services/frappe/fee-discounts"

const ROW = {
  username: "civilizedbarbarian",
  discount_percent: 50,
  applies_to_topup: 1,
  applies_to_cashout: 1,
  active: 1,
}

let now = 1_000_000

beforeEach(() => {
  jest.clearAllMocks()
  _resetFeeDiscountsCache()
  now = 1_000_000
  jest.spyOn(Date, "now").mockImplementation(() => now)
  mockGetFeeDiscounts.mockResolvedValue([{ ...ROW }])
})

afterEach(() => {
  ;(Date.now as jest.Mock).mockRestore?.()
})

describe("validateFeeDiscountDoc", () => {
  it("maps a well-formed row", () => {
    expect(validateFeeDiscountDoc({ ...ROW })).toEqual({
      username: "civilizedbarbarian",
      discount: { discountPercent: 50, appliesToTopup: true, appliesToCashout: true },
    })
  })

  it("coerces numeric strings and check-field encodings", () => {
    expect(
      validateFeeDiscountDoc({
        username: " bob ",
        discount_percent: "12.5",
        applies_to_topup: "1",
        applies_to_cashout: 0,
        active: 1,
      }),
    ).toEqual({
      username: "bob",
      discount: { discountPercent: 12.5, appliesToTopup: true, appliesToCashout: false },
    })
  })

  it("lowercases the username key (platform usernames are case-insensitive)", () => {
    expect(validateFeeDiscountDoc({ ...ROW, username: "RegginaB" })).toEqual({
      username: "regginab",
      discount: { discountPercent: 50, appliesToTopup: true, appliesToCashout: true },
    })
  })

  it.each([
    ["blank username", { ...ROW, username: "  " }],
    ["missing username", { ...ROW, username: undefined }],
    ["non-numeric percent", { ...ROW, discount_percent: "abc" }],
    ["negative percent", { ...ROW, discount_percent: -1 }],
    ["percent over 100", { ...ROW, discount_percent: 101 }],
    // Unticking Active is how an operator ends a promo. The ERPNext query
    // filters on active=1, but that filter must not be the ONLY thing
    // enforcing it: this reader fails OPEN, so a dropped or mis-encoded
    // filter would keep every deactivated row discounting Flash's fee
    // indefinitely with nothing to alarm on.
    ["active unticked", { ...ROW, active: 0 }],
    ["active missing", { ...ROW, active: undefined }],
    ["active as an unrecognized string", { ...ROW, active: "no" }],
  ])("rejects a row with %s", (_label, doc) => {
    expect(validateFeeDiscountDoc(doc)).toBeUndefined()
  })

  it("accepts the check-field encodings ERPNext uses for Active", () => {
    expect(validateFeeDiscountDoc({ ...ROW, active: "1" })).toBeDefined()
    expect(validateFeeDiscountDoc({ ...ROW, active: true })).toBeDefined()
  })
})

describe("getFlashFeeDiscountPercent", () => {
  it("returns the discount for a whitelisted user in a covered flow", async () => {
    await expect(
      getFlashFeeDiscountPercent({ username: "civilizedbarbarian", flow: "topup" }),
    ).resolves.toBe(50)
    await expect(
      getFlashFeeDiscountPercent({ username: "civilizedbarbarian", flow: "cashout" }),
    ).resolves.toBe(50)
  })

  it("matches case-insensitively between the whitelisted and registered casing", async () => {
    // Usernames are case-insensitive platform-wide (findByUsername uses
    // collation strength 2), so account.username carries registration case
    // while the operator types an arbitrary casing into ERPNext. A user
    // registered "RegginaB" whitelisted as "regginab" must still match —
    // and vice versa.
    mockGetFeeDiscounts.mockResolvedValue([{ ...ROW, username: "regginab" }])
    await expect(
      getFlashFeeDiscountPercent({ username: "RegginaB", flow: "topup" }),
    ).resolves.toBe(50)

    _resetFeeDiscountsCache()
    mockGetFeeDiscounts.mockResolvedValue([{ ...ROW, username: "RegginaB" }])
    await expect(
      getFlashFeeDiscountPercent({ username: "regginab", flow: "topup" }),
    ).resolves.toBe(50)
  })

  it("returns 0 for users not on the whitelist", async () => {
    await expect(
      getFlashFeeDiscountPercent({ username: "someone-else", flow: "topup" }),
    ).resolves.toBe(0)
  })

  it("returns 0 for an undefined username (accounts without one)", async () => {
    await expect(
      getFlashFeeDiscountPercent({ username: undefined, flow: "topup" }),
    ).resolves.toBe(0)
    expect(mockGetFeeDiscounts).not.toHaveBeenCalled()
  })

  it("scopes the discount to the flows the row covers", async () => {
    mockGetFeeDiscounts.mockResolvedValue([
      { ...ROW, applies_to_topup: 1, applies_to_cashout: 0 },
    ])
    await expect(
      getFlashFeeDiscountPercent({ username: "civilizedbarbarian", flow: "topup" }),
    ).resolves.toBe(50)
    await expect(
      getFlashFeeDiscountPercent({ username: "civilizedbarbarian", flow: "cashout" }),
    ).resolves.toBe(0)
  })

  it("fails open to 0 when the ERPNext read errors, and caches the failure", async () => {
    mockGetFeeDiscounts.mockResolvedValue(new FeeDiscountQueryError("boom"))
    await expect(
      getFlashFeeDiscountPercent({ username: "civilizedbarbarian", flow: "topup" }),
    ).resolves.toBe(0)
    // The failure is memoised — no fetch storm during an outage.
    await getFlashFeeDiscountPercent({ username: "civilizedbarbarian", flow: "topup" })
    expect(mockGetFeeDiscounts).toHaveBeenCalledTimes(1)
  })

  it("fails open to 0 when the reader throws unexpectedly", async () => {
    mockGetFeeDiscounts.mockRejectedValue(new Error("network down"))
    await expect(
      getFlashFeeDiscountPercent({ username: "civilizedbarbarian", flow: "topup" }),
    ).resolves.toBe(0)
  })

  it("returns 0 for a deactivated row even if ERPNext hands one back", async () => {
    // Defence in depth against the active=1 query filter being lost: the row
    // is on the whitelist but the operator ended the promo, so the user pays
    // the standard fee.
    mockGetFeeDiscounts.mockResolvedValue([{ ...ROW, active: 0 }])

    await expect(
      getFlashFeeDiscountPercent({ username: "civilizedbarbarian", flow: "topup" }),
    ).resolves.toBe(0)
    await expect(
      getFlashFeeDiscountPercent({ username: "civilizedbarbarian", flow: "cashout" }),
    ).resolves.toBe(0)
  })

  it("drops malformed rows without taking out the rest of the whitelist", async () => {
    mockGetFeeDiscounts.mockResolvedValue([
      { username: "broken", discount_percent: "abc" },
      { ...ROW },
    ])
    await expect(
      getFlashFeeDiscountPercent({ username: "civilizedbarbarian", flow: "topup" }),
    ).resolves.toBe(50)
    await expect(
      getFlashFeeDiscountPercent({ username: "broken", flow: "topup" }),
    ).resolves.toBe(0)
  })

  it("serves from cache within the TTL and re-reads after it", async () => {
    await getFlashFeeDiscountPercent({ username: "civilizedbarbarian", flow: "topup" })
    now += 30_000
    await getFlashFeeDiscountPercent({ username: "civilizedbarbarian", flow: "topup" })
    expect(mockGetFeeDiscounts).toHaveBeenCalledTimes(1)

    now += 31_000 // past the 60s TTL
    mockGetFeeDiscounts.mockResolvedValue([{ ...ROW, discount_percent: 75 }])
    await expect(
      getFlashFeeDiscountPercent({ username: "civilizedbarbarian", flow: "topup" }),
    ).resolves.toBe(75)
    expect(mockGetFeeDiscounts).toHaveBeenCalledTimes(2)
  })
})
