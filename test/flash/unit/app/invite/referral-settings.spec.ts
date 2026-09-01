/**
 * The ERPNext referral-rewards kill switch. The polarity IS the feature:
 * money moves only on an affirmative, readable rewards_enabled=1 — disabled,
 * unreadable, missing, and malformed must all read as "do not pay".
 */
const mockGetReferralSettings = jest.fn()
jest.mock("@services/frappe/ErpNext", () => ({
  __esModule: true,
  default: {
    getReferralSettings: (...a: unknown[]) => mockGetReferralSettings(...a),
  },
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}))

import {
  referralRewardsEnabledInErp,
  resetReferralSettingsCache,
} from "@app/invite/referral-settings"
import { ReferralSettingsQueryError } from "@services/frappe/errors"

beforeEach(() => {
  jest.clearAllMocks()
  resetReferralSettingsCache()
})

describe("referralRewardsEnabledInErp", () => {
  it("returns true only on an affirmative rewards_enabled", async () => {
    mockGetReferralSettings.mockResolvedValue({ rewards_enabled: 1 })

    await expect(referralRewardsEnabledInErp()).resolves.toBe(true)
  })

  it.each([
    ["switch off", { rewards_enabled: 0 }],
    ["field missing (pre-migration ERP row)", {}],
    ["malformed field", { rewards_enabled: "banana" }],
  ])("returns false when %s", async (_label, doc) => {
    mockGetReferralSettings.mockResolvedValue(doc)

    await expect(referralRewardsEnabledInErp()).resolves.toBe(false)
  })

  it("fails CLOSED on a read error — an outage must not pay rewards", async () => {
    mockGetReferralSettings.mockResolvedValue(new ReferralSettingsQueryError("erp down"))

    await expect(referralRewardsEnabledInErp()).resolves.toBe(false)
  })

  it("memoises for the TTL — a KYC burst is one ERP read, not a fetch storm", async () => {
    mockGetReferralSettings.mockResolvedValue({ rewards_enabled: 1 })

    await referralRewardsEnabledInErp()
    await referralRewardsEnabledInErp()
    await referralRewardsEnabledInErp()

    expect(mockGetReferralSettings).toHaveBeenCalledTimes(1)
  })

  it("caches failures too, so an ERP outage cannot become a retry storm", async () => {
    mockGetReferralSettings.mockResolvedValue(new ReferralSettingsQueryError("erp down"))

    await expect(referralRewardsEnabledInErp()).resolves.toBe(false)
    await expect(referralRewardsEnabledInErp()).resolves.toBe(false)

    expect(mockGetReferralSettings).toHaveBeenCalledTimes(1)
  })
})
