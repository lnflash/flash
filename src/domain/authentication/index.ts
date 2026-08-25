import { ChannelType, PhoneCodeInvalidError } from "@domain/phone-provider"

import { EmailCodeInvalidError } from "./errors"

// The unsupported-country lists come straight from the configmap
// (src/config/yaml.ts casts them to CountryCode[] without validating), so an
// operator can write `uz` where `UZ` was meant. Comparing raw would make the
// fraud control silently do nothing and stop filtering the picker at the same
// time — both failures invisible. Normalize on every comparison instead.
const normalizeCountryCodes = (countries: CountryCode[]): string[] =>
  countries.map((country) => String(country).toUpperCase())

export const getSupportedCountries = ({
  allCountries,
  unsupportedSmsCountries,
  unsupportedWhatsAppCountries,
}: {
  allCountries: CountryCode[]
  unsupportedSmsCountries: CountryCode[]
  unsupportedWhatsAppCountries: CountryCode[]
}): Country[] => {
  const countries: Country[] = []
  const unsupportedSms = normalizeCountryCodes(unsupportedSmsCountries)
  const unsupportedWhatsApp = normalizeCountryCodes(unsupportedWhatsAppCountries)

  for (const country of allCountries) {
    const supportedAuthMethods: ChannelType[] = []
    const normalizedCountry = String(country).toUpperCase()

    if (!unsupportedSms.includes(normalizedCountry)) {
      supportedAuthMethods.push(ChannelType.Sms)
    }

    if (!unsupportedWhatsApp.includes(normalizedCountry)) {
      supportedAuthMethods.push(ChannelType.Whatsapp)
    }

    if (supportedAuthMethods.length > 0) {
      countries.push({
        id: country,
        supportedAuthChannels: supportedAuthMethods,
      })
    }
  }

  return countries
}

// The server-side fraud control, gated on the BLOCKED lists — not on the
// picker's unsupported lists. The two are separate config keys on purpose: a
// country hidden from the picker can never be selected, so the existing-user
// carve-out in requestPhoneCode* would be unreachable for it.
export const isAuthChannelSupportedForCountry = ({
  countryCode,
  channel,
  blockedSmsCountries,
  blockedWhatsAppCountries,
}: {
  countryCode: CountryCode
  channel: ChannelType
  blockedSmsCountries: CountryCode[]
  blockedWhatsAppCountries: CountryCode[]
}): boolean => {
  const blockedCountries =
    channel === ChannelType.Whatsapp ? blockedWhatsAppCountries : blockedSmsCountries

  return !normalizeCountryCodes(blockedCountries).includes(
    String(countryCode).toUpperCase(),
  )
}

export const checkedToEmailCode = (code: string): EmailCode | ApplicationError => {
  if (!/^[0-9]{6}$/.test(code)) return new EmailCodeInvalidError()
  return code as EmailCode
}

export const validOneTimeAuthCodeValue = (code: string) => {
  if (code.match(/^[0-9]{6}/i)) {
    return code as PhoneCode
  }
  return new PhoneCodeInvalidError({ message: "Invalid value for OneTimeAuthCode" })
}
