import { configSchema } from "../../../../src/config/schema"

describe("config schema", () => {
  it("requires bridge developerFeePercent without a hardcoded default", () => {
    const bridgeSchema = configSchema.properties.bridge

    expect(bridgeSchema.properties.developerFeePercent).toEqual({ type: "number" })
    expect(bridgeSchema.required).toContain("developerFeePercent")
  })

  // These defaults ARE the SMS-pumping control for any environment whose
  // configmap omits the key. Every other test in the suite mocks @config, so
  // without this the seeded lists could be reverted to [] and stay green.
  describe("SMS-pumping blocklist defaults", () => {
    const smsDefault = configSchema.properties.smsAuthUnsupportedCountries
      .default as string[]
    const whatsAppDefault = configSchema.properties.whatsAppAuthUnsupportedCountries
      .default as string[]

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
