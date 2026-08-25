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
