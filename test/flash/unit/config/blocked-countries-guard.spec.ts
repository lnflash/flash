jest.mock("@services/logger", () => ({
  baseLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
  },
}))

import { reportAmbiguousBlockedCountries } from "@config"
import { baseLogger } from "@services/logger"

// checkAuthCodeDestination gates a number whose region libphonenumber cannot
// name against EVERY region its calling code could denote. The block list is
// operator-tunable from the ops feed, so a configmap can widen that candidate
// set — and break signup for a market nobody meant to block — without touching
// the schema default that schema.spec.ts pins.
describe("reportAmbiguousBlockedCountries", () => {
  beforeEach(jest.clearAllMocks)

  it("stays silent when no blocked country shares a calling code", () => {
    reportAmbiguousBlockedCountries("smsAuthBlockedCountries", ["TR", "UZ", "LB"])

    expect(baseLogger.error).not.toHaveBeenCalled()
    expect(baseLogger.warn).not.toHaveBeenCalled()
  })

  // The failure this exists for: DO is +1 809/829/849, so blocking it rejects
  // every US number on the ~340 assigned area codes the pinned metadata does
  // not carry (+1 983, +1 738, +1 924, +1 472…).
  it("logs at error level when a NANP region is blocked", () => {
    reportAmbiguousBlockedCountries("smsAuthBlockedCountries", ["UZ", "DO"])

    expect(baseLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "smsAuthBlockedCountries",
        blockedCountry: "DO",
        callingCode: "1",
        unblockedSiblings: expect.arrayContaining(["US"]),
      }),
      expect.stringContaining("DO"),
    )
  })

  it("names the key that carries the bad entry", () => {
    reportAmbiguousBlockedCountries("whatsAppAuthBlockedCountries", ["CA"])

    expect(baseLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ key: "whatsAppAuthBlockedCountries" }),
      expect.stringContaining("whatsAppAuthBlockedCountries"),
    )
  })

  // Collateral on any other calling code costs a market we did not choose to
  // block, which is a deliberate trade rather than a broken core market.
  it("warns, not errors, for collateral outside the NANP", () => {
    reportAmbiguousBlockedCountries("smsAuthBlockedCountries", ["RU"])

    expect(baseLogger.error).not.toHaveBeenCalled()
    expect(baseLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ blockedCountry: "RU", unblockedSiblings: ["KZ"] }),
      expect.stringContaining("KZ"),
    )
  })

  it("says nothing once every region on the calling code is blocked", () => {
    reportAmbiguousBlockedCountries("smsAuthBlockedCountries", ["RU", "KZ"])

    expect(baseLogger.error).not.toHaveBeenCalled()
    expect(baseLogger.warn).not.toHaveBeenCalled()
  })

  it("matches a lowercase configmap entry", () => {
    reportAmbiguousBlockedCountries("smsAuthBlockedCountries", ["do"])

    expect(baseLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ blockedCountry: "DO", callingCode: "1" }),
      expect.any(String),
    )
  })

  // XK (Kosovo) is on the seeded list and is not a region libphonenumber knows.
  it("skips a code libphonenumber cannot resolve instead of throwing", () => {
    expect(() =>
      reportAmbiguousBlockedCountries("smsAuthBlockedCountries", ["XK"]),
    ).not.toThrow()
    expect(baseLogger.error).not.toHaveBeenCalled()
    expect(baseLogger.warn).not.toHaveBeenCalled()
  })
})
