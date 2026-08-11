jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock("@services/frappe/ErpNext", () => ({
  __esModule: true,
  default: { getFygaroSettings: (...args: unknown[]) => mockGetFygaroSettings(...args) },
}))

const mockGetFygaroSettings = jest.fn()

import {
  getFygaroSettings,
  validateFygaroSettings,
  _resetFygaroSettingsCache,
} from "@services/fygaro/webhook-server/fygaro-settings"

const GOOD_DOC = {
  processor: "Fygaro",
  processor_fee_percent: 2.99,
  processor_fee_fixed: 0.49,
  flash_margin_percent: 2.0,
  flash_margin_fixed: 0,
  auto_credit_limit: 500,
  minimum_topup: 10,
  auto_credit_enabled: 1,
}

let now = 1_000_000

beforeEach(() => {
  jest.clearAllMocks()
  _resetFygaroSettingsCache()
  now = 1_000_000
  jest.spyOn(Date, "now").mockImplementation(() => now)
  mockGetFygaroSettings.mockResolvedValue({ ...GOOD_DOC })
})

afterEach(() => {
  ;(Date.now as jest.Mock).mockRestore?.()
})

describe("validateFygaroSettings", () => {
  it("maps a well-formed doc to typed settings", () => {
    expect(validateFygaroSettings({ ...GOOD_DOC })).toEqual({
      processor: "Fygaro",
      processorFeePercent: 2.99,
      processorFeeFixed: 0.49,
      flashMarginPercent: 2.0,
      flashMarginFixed: 0,
      autoCreditLimit: 500,
      minimumTopup: 10,
      autoCreditEnabled: true,
    })
  })

  it("coerces numeric strings from ERPNext", () => {
    const result = validateFygaroSettings({
      ...GOOD_DOC,
      processor_fee_percent: "2.99",
      auto_credit_limit: "500",
    })
    expect(result?.processorFeePercent).toBe(2.99)
    expect(result?.autoCreditLimit).toBe(500)
  })

  it.each([
    ["true boolean", true, true],
    ["numeric 1", 1, true],
    ['string "1"', "1", true],
    ["numeric 0", 0, false],
    ["undefined", undefined, false],
  ])("reads auto_credit_enabled from %s", (_label, raw, expected) => {
    const result = validateFygaroSettings({ ...GOOD_DOC, auto_credit_enabled: raw })
    expect(result?.autoCreditEnabled).toBe(expected)
  })

  it.each([
    ["undefined", undefined],
    ["a missing numeric field", { ...GOOD_DOC, processor_fee_percent: undefined }],
    ["a non-numeric string", { ...GOOD_DOC, processor_fee_fixed: "abc" }],
    ["a negative fee", { ...GOOD_DOC, flash_margin_percent: -1 }],
    ["a negative limit", { ...GOOD_DOC, auto_credit_limit: -5 }],
  ])("returns undefined for %s (garbage)", (_label, doc) => {
    expect(validateFygaroSettings(doc as never)).toBeUndefined()
  })
})

describe("getFygaroSettings", () => {
  it("reads, validates, and returns settings", async () => {
    const result = await getFygaroSettings()
    expect(result?.processorFeePercent).toBe(2.99)
    expect(result?.autoCreditEnabled).toBe(true)
    expect(mockGetFygaroSettings).toHaveBeenCalledTimes(1)
  })

  it("caches within the TTL and does not re-read ERPNext", async () => {
    await getFygaroSettings()
    now += 30_000 // still inside the 60s window
    await getFygaroSettings()
    expect(mockGetFygaroSettings).toHaveBeenCalledTimes(1)
  })

  it("re-reads ERPNext after the TTL expires", async () => {
    await getFygaroSettings()
    now += 61_000
    await getFygaroSettings()
    expect(mockGetFygaroSettings).toHaveBeenCalledTimes(2)
  })

  it("falls back to undefined (record-only) when the ERPNext read fails", async () => {
    mockGetFygaroSettings.mockResolvedValue(new Error("erpnext down"))
    expect(await getFygaroSettings()).toBeUndefined()
  })

  it("caches the failure so an outage does not hammer ERPNext", async () => {
    mockGetFygaroSettings.mockResolvedValue(new Error("erpnext down"))
    await getFygaroSettings()
    now += 30_000
    await getFygaroSettings()
    expect(mockGetFygaroSettings).toHaveBeenCalledTimes(1)
  })

  it("recovers after the TTL once ERPNext returns valid settings again", async () => {
    mockGetFygaroSettings.mockResolvedValue(new Error("erpnext down"))
    expect(await getFygaroSettings()).toBeUndefined()

    now += 61_000
    mockGetFygaroSettings.mockResolvedValue({ ...GOOD_DOC })
    expect((await getFygaroSettings())?.processorFeePercent).toBe(2.99)
  })

  it("treats a malformed row as unavailable", async () => {
    mockGetFygaroSettings.mockResolvedValue({ ...GOOD_DOC, processor_fee_percent: "N/A" })
    expect(await getFygaroSettings()).toBeUndefined()
  })
})
