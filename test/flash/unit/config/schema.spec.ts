import { getCountries, getCountryCallingCode } from "libphonenumber-js"

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

    // checkAuthCodeDestination cannot name a region for every number it parses
    // — ~340 assigned NANP area codes are absent from the pinned
    // libphonenumber-js metadata — so it gates such a number against EVERY
    // region its calling code could denote, and fails closed if any is blocked.
    // The safety of the +1 path therefore rests on this invariant. Block DO
    // (+1 809/829/849) and every US number on +1 983 / +1 738 / +1 924 /
    // +1 472 starts getting PhoneCountryNotAllowedError.
    describe("no entry shares a calling code with an unblocked region", () => {
      type Region = ReturnType<typeof getCountries>[number]

      const callingCodeOf = (code: string): string | undefined => {
        try {
          return getCountryCallingCode(code as Region)
        } catch {
          // Not a region libphonenumber knows (XK). It can never be a parsed
          // number's region, so it cannot widen a candidate set either.
          return undefined
        }
      }

      it("blocks no NANP region, so +1 numbers the metadata cannot attribute still send", () => {
        for (const code of [...smsDefault, ...whatsAppDefault]) {
          expect(callingCodeOf(code)).not.toBe("1")
        }
      })

      // Blocking a country also blocks any unattributable number on its calling
      // code, which is collateral against a market we have not decided to
      // block. RU/KZ (+7) is the one accepted instance; pinning the whole set
      // means the next one has to be argued for here rather than shipped by
      // appending a line to a configmap.
      it("has exactly one accepted collateral region, and it is KZ behind RU", () => {
        for (const list of [smsDefault, whatsAppDefault]) {
          const blocked = new Set(list)
          const collateral: Record<string, string[]> = {}

          for (const code of list) {
            const callingCode = callingCodeOf(code)
            if (callingCode === undefined) continue

            const unblockedSiblings = getCountries().filter(
              (country) =>
                country !== code &&
                getCountryCallingCode(country) === callingCode &&
                !blocked.has(country),
            )
            if (unblockedSiblings.length > 0) collateral[code] = unblockedSiblings
          }

          expect(collateral).toEqual({ RU: ["KZ"] })
        }
      })
    })

    // Ajv's `useDefaults` assigns by reference. One shared array instance would
    // make both config keys — and this schema object — the same live array in
    // every environment whose configmap sets neither key, so the first push or
    // splice against one would silently change the other.
    it("gives each key its own array instance", () => {
      expect(smsDefault).not.toBe(whatsAppDefault)
      expect(smsDefault).toEqual(whatsAppDefault)
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
