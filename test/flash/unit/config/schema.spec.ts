import { configSchema } from "../../../../src/config/schema"

describe("config schema", () => {
  it("requires bridge developerFeePercent without a hardcoded default", () => {
    const bridgeSchema = configSchema.properties.bridge

    expect(bridgeSchema.properties.developerFeePercent).toEqual({ type: "number" })
    expect(bridgeSchema.required).toContain("developerFeePercent")
  })

  // The per-IP request-code budget is one of the two numbers this control is
  // made of, and no other test in the suite asserts it — every other spec mocks
  // @config, so it could be reverted to its old 16 and stay green.
  it("caps request-code attempts per IP at 8 an hour", () => {
    expect(configSchema.properties.rateLimits.default.requestCodePerIp).toEqual({
      points: 8,
      duration: 3600,
      blockDuration: 86400,
    })
  })

  // These defaults ARE the SMS-pumping control for any environment whose
  // configmap omits the key. Every other test in the suite mocks @config, so
  // without this the seeded lists could be reverted to [] and stay green.
  describe("SMS-pumping blocklist defaults", () => {
    const smsDefault = configSchema.properties.smsAuthBlockedCountries.default as string[]
    const whatsAppDefault = configSchema.properties.whatsAppAuthBlockedCountries
      .default as string[]

    // The block list is enforced server-side, where the existing-user carve-out
    // can still serve a real account. The picker list hides a country from the
    // client entirely — seeding it with the same codes would mean no UZ account
    // could even select +998, and the carve-out would never run for anyone.
    it("keeps the picker filter empty by default, so the carve-out stays reachable", () => {
      expect(configSchema.properties.smsAuthUnsupportedCountries.default).toEqual([])
      expect(configSchema.properties.whatsAppAuthUnsupportedCountries.default).toEqual([])
    })

    it("seeds the sms auth blocklist with the attack-origin countries", () => {
      expect(smsDefault).toHaveLength(25)
      expect(smsDefault).toEqual(expect.arrayContaining(["UZ", "TR"]))
    })

    it("seeds the whatsapp auth blocklist with the attack-origin countries", () => {
      expect(whatsAppDefault).toHaveLength(25)
      expect(whatsAppDefault).toEqual(expect.arrayContaining(["UZ", "TR"]))
    })

    it("keeps every entry an uppercase ISO-3166 alpha-2 code", () => {
      for (const code of [...smsDefault, ...whatsAppDefault]) {
        expect(code).toMatch(/^[A-Z]{2}$/)
      }
    })

    it("never blocks a country that has produced a real signup", () => {
      const convertedCountries = [
        "JM",
        "US",
        "NG",
        "IN",
        "GB",
        "CA",
        "DE",
        "GH",
        "KY",
        "BJ",
        "RW",
        "SD",
        "CD",
        "MV",
        "BD",
        "BE",
        "UG",
        "TT",
        "ML",
        "CO",
        "SK",
      ]

      for (const code of convertedCountries) {
        expect(smsDefault).not.toContain(code)
        expect(whatsAppDefault).not.toContain(code)
      }
    })
  })
})
