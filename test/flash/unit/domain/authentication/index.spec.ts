import {
  getSupportedCountries,
  isAuthChannelSupportedForCountry,
} from "@domain/authentication"
import { ChannelType } from "@domain/phone-provider"

describe("getSupportedCountries", () => {
  it("returns supported countries", () => {
    const countries = getSupportedCountries({
      allCountries: ["CA", "US", "SV"] as CountryCode[],
      unsupportedSmsCountries: ["CA", "SV"] as CountryCode[],
      unsupportedWhatsAppCountries: ["US", "SV"] as CountryCode[],
    })

    expect(countries).toEqual([
      {
        id: "CA",
        supportedAuthChannels: ["whatsapp"],
      },
      {
        id: "US",
        supportedAuthChannels: ["sms"],
      },
    ])
  })

  // The lists are raw configmap strings, never validated. A lowercase entry
  // must not silently stop filtering the picker.
  it("filters a lowercase configmap entry", () => {
    const countries = getSupportedCountries({
      allCountries: ["CA", "US"] as CountryCode[],
      unsupportedSmsCountries: ["ca"] as CountryCode[],
      unsupportedWhatsAppCountries: ["ca"] as CountryCode[],
    })

    expect(countries).toEqual([
      {
        id: "US",
        supportedAuthChannels: ["sms", "whatsapp"],
      },
    ])
  })
})

describe("isAuthChannelSupportedForCountry", () => {
  const unsupportedSmsCountries = ["UZ", "RU"] as CountryCode[]
  const unsupportedWhatsAppCountries = ["UZ", "BR"] as CountryCode[]

  const check = (countryCode: string, channel: ChannelType) =>
    isAuthChannelSupportedForCountry({
      countryCode: countryCode as CountryCode,
      channel,
      unsupportedSmsCountries,
      unsupportedWhatsAppCountries,
    })

  it("allows a country on neither list", () => {
    expect(check("JM", ChannelType.Sms)).toBe(true)
    expect(check("JM", ChannelType.Whatsapp)).toBe(true)
  })

  it("blocks a country on the list for that channel only", () => {
    expect(check("RU", ChannelType.Sms)).toBe(false)
    expect(check("RU", ChannelType.Whatsapp)).toBe(true)

    expect(check("BR", ChannelType.Whatsapp)).toBe(false)
    expect(check("BR", ChannelType.Sms)).toBe(true)
  })

  it("blocks a country listed for both channels", () => {
    expect(check("UZ", ChannelType.Sms)).toBe(false)
    expect(check("UZ", ChannelType.Whatsapp)).toBe(false)
  })

  // An operator writing `- uz` in the Helm values must still get a working
  // fraud control; a silently-inert blocklist is the worst failure mode here.
  it("blocks a lowercase configmap entry", () => {
    expect(
      isAuthChannelSupportedForCountry({
        countryCode: "UZ" as CountryCode,
        channel: ChannelType.Sms,
        unsupportedSmsCountries: ["uz"] as CountryCode[],
        unsupportedWhatsAppCountries: [],
      }),
    ).toBe(false)

    expect(
      isAuthChannelSupportedForCountry({
        countryCode: "uz" as CountryCode,
        channel: ChannelType.Whatsapp,
        unsupportedSmsCountries: [],
        unsupportedWhatsAppCountries: ["UZ"] as CountryCode[],
      }),
    ).toBe(false)
  })

  it("allows every country when the lists are empty", () => {
    expect(
      isAuthChannelSupportedForCountry({
        countryCode: "UZ" as CountryCode,
        channel: ChannelType.Sms,
        unsupportedSmsCountries: [],
        unsupportedWhatsAppCountries: [],
      }),
    ).toBe(true)
  })
})
