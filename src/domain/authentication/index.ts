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

export const isAuthChannelSupportedForCountry = ({
  countryCode,
  channel,
  unsupportedSmsCountries,
  unsupportedWhatsAppCountries,
}: {
  countryCode: CountryCode
  channel: ChannelType
  unsupportedSmsCountries: CountryCode[]
  unsupportedWhatsAppCountries: CountryCode[]
}): boolean => {
  const unsupportedCountries =
    channel === ChannelType.Whatsapp
      ? unsupportedWhatsAppCountries
      : unsupportedSmsCountries

  return !normalizeCountryCodes(unsupportedCountries).includes(
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
