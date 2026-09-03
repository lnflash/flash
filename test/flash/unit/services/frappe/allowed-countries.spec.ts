jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock("@services/frappe/ErpNext", () => ({
  __esModule: true,
  default: {
    getAllowedCountries: (...args: unknown[]) => mockGetAllowedCountries(...args),
  },
}))

const mockGetAllowedCountries = jest.fn()

import { AllowedCountryQueryError } from "@services/frappe/errors"
import {
  getAllowedCountries,
  validateAllowedCountryDoc,
  _resetAllowedCountriesCache,
} from "@services/frappe/allowed-countries"

const ROWS = [
  { alpha2_code: "JM", country_name: "Jamaica", flash_allowed: 1 },
  { alpha2_code: "us", country_name: "United States", flash_allowed: "1" },
]
const FALLBACK = ["JM", "GB"]

let now = 1_000_000

beforeEach(() => {
  jest.clearAllMocks()
  _resetAllowedCountriesCache()
  now = 1_000_000
  jest.spyOn(Date, "now").mockImplementation(() => now)
  mockGetAllowedCountries.mockResolvedValue(ROWS.map((r) => ({ ...r })))
})

afterEach(() => {
  ;(Date.now as jest.Mock).mockRestore?.()
})

describe("validateAllowedCountryDoc", () => {
  it("normalises a well-formed row to an upper-case alpha-2 code", () => {
    expect(validateAllowedCountryDoc({ alpha2_code: " jm ", flash_allowed: 1 })).toBe(
      "JM",
    )
    expect(validateAllowedCountryDoc({ alpha2_code: "US", flash_allowed: true })).toBe(
      "US",
    )
    expect(validateAllowedCountryDoc({ alpha2_code: "GB", flash_allowed: "1" })).toBe(
      "GB",
    )
  })

  it.each([
    ["flash_allowed unticked", { alpha2_code: "JM", flash_allowed: 0 }],
    ["flash_allowed missing", { alpha2_code: "JM" }],
    ["blank code", { alpha2_code: "  ", flash_allowed: 1 }],
    ["missing code", { flash_allowed: 1 }],
    ["three-letter code", { alpha2_code: "JAM", flash_allowed: 1 }],
    ["non-letter code", { alpha2_code: "J1", flash_allowed: 1 }],
  ])("rejects a row with %s", (_label, doc) => {
    expect(validateAllowedCountryDoc(doc)).toBeUndefined()
  })
})

// `source: "config"` is the default, and what makes this PR safe to deploy
// before the frappe-flash-admin reseed: the ERPNext doctype as seeded before
// that patch ticks flash_allowed for 165 countries, NG and IN included.
describe("getAllowedCountries with source: config", () => {
  it("returns the config list and never reads ERPNext", async () => {
    const allowed = await getAllowedCountries({ source: "config", fallback: FALLBACK })

    expect([...allowed].sort()).toEqual(["GB", "JM"])
    expect(mockGetAllowedCountries).not.toHaveBeenCalled()
  })

  it("normalises the config list and drops garbage in it", async () => {
    const allowed = await getAllowedCountries({
      source: "config",
      fallback: [" jm", "gb ", "JAM", "", "j1"],
    })

    expect([...allowed].sort()).toEqual(["GB", "JM"])
  })

  it("does not poison the ERPNext cache: a later erpnext read still reads", async () => {
    await getAllowedCountries({ source: "config", fallback: FALLBACK })

    const allowed = await getAllowedCountries({ source: "erpnext", fallback: FALLBACK })

    expect(mockGetAllowedCountries).toHaveBeenCalledTimes(1)
    expect([...allowed].sort()).toEqual(["JM", "US"])
  })

  it("is empty for an empty config list — denies by default rather than widening", async () => {
    const allowed = await getAllowedCountries({ source: "config", fallback: [] })

    expect(allowed.size).toBe(0)
    expect(mockGetAllowedCountries).not.toHaveBeenCalled()
  })
})

describe("getAllowedCountries with source: erpnext", () => {
  it("returns the ERPNext allowlist as upper-case codes", async () => {
    const allowed = await getAllowedCountries({ source: "erpnext", fallback: FALLBACK })
    expect([...allowed].sort()).toEqual(["JM", "US"])
  })

  it("falls back to the config list when the ERPNext read errors, and caches it", async () => {
    mockGetAllowedCountries.mockResolvedValue(new AllowedCountryQueryError("boom"))

    const allowed = await getAllowedCountries({ source: "erpnext", fallback: FALLBACK })
    expect([...allowed].sort()).toEqual(["GB", "JM"])

    await getAllowedCountries({ source: "erpnext", fallback: FALLBACK })
    expect(mockGetAllowedCountries).toHaveBeenCalledTimes(1)
  })

  it("falls back to the config list when the reader throws unexpectedly", async () => {
    mockGetAllowedCountries.mockRejectedValue(new Error("network down"))
    const allowed = await getAllowedCountries({ source: "erpnext", fallback: FALLBACK })
    expect([...allowed].sort()).toEqual(["GB", "JM"])
  })

  it("falls back to the config list when ERPNext returns no allowed rows", async () => {
    mockGetAllowedCountries.mockResolvedValue([])
    const allowed = await getAllowedCountries({ source: "erpnext", fallback: FALLBACK })
    expect([...allowed].sort()).toEqual(["GB", "JM"])
  })

  it("normalises the fallback list and drops garbage in it", async () => {
    mockGetAllowedCountries.mockResolvedValue([])
    const allowed = await getAllowedCountries({
      source: "erpnext",
      fallback: [" jm", "gb ", "JAM", ""],
    })
    expect([...allowed].sort()).toEqual(["GB", "JM"])
  })

  it("never widens the allowlist from a row whose tick is off", async () => {
    // Defence in depth against the flash_allowed=1 query filter being lost.
    mockGetAllowedCountries.mockResolvedValue([
      { alpha2_code: "JM", flash_allowed: 1 },
      { alpha2_code: "IN", flash_allowed: 0 },
    ])
    const allowed = await getAllowedCountries({ source: "erpnext", fallback: FALLBACK })
    expect([...allowed]).toEqual(["JM"])
  })

  it("drops malformed rows without taking out the rest of the allowlist", async () => {
    mockGetAllowedCountries.mockResolvedValue([
      { alpha2_code: "???", flash_allowed: 1 },
      { alpha2_code: "JM", flash_allowed: 1 },
    ])
    const allowed = await getAllowedCountries({ source: "erpnext", fallback: FALLBACK })
    expect([...allowed]).toEqual(["JM"])
  })

  it("serves from cache within the TTL and re-reads after it", async () => {
    await getAllowedCountries({ source: "erpnext", fallback: FALLBACK })
    now += 30_000
    await getAllowedCountries({ source: "erpnext", fallback: FALLBACK })
    expect(mockGetAllowedCountries).toHaveBeenCalledTimes(1)

    now += 31_000 // past the 60s TTL
    mockGetAllowedCountries.mockResolvedValue([{ alpha2_code: "TT", flash_allowed: 1 }])
    const allowed = await getAllowedCountries({ source: "erpnext", fallback: FALLBACK })
    expect([...allowed]).toEqual(["TT"])
    expect(mockGetAllowedCountries).toHaveBeenCalledTimes(2)
  })
})
