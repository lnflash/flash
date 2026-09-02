import { parsePhoneNumberFromString } from "libphonenumber-js"

import { countriesForCallingCode } from "@domain/users/phone-regions"
import { getAllowedCountries } from "@services/frappe/allowed-countries"
import { toAlpha2 } from "@services/frappe/coerce"
import { IdentityRepository } from "@services/kratos"
import { baseLogger } from "@services/logger"
import { addAttributesToCurrentSpan } from "@services/tracing"
import {
  BridgeKycCountryNotSupportedError,
  BridgeKycEmailNotVerifiedError,
  BridgeKycPhoneRequiredError,
} from "@services/bridge/errors"

// Gate in front of bridgeInitiateKyc.
//
// On 2026-09-01 a wave of reward-hunting signups from countries Bridge cannot
// issue Flash a USD virtual account for started KYC within minutes of
// registering; Bridge approved them and then refused the virtual account
// ("The customer is not authorized to create USD Virtual Accounts"). The user
// did the work, got a green check, and still had nothing.
//
// The gate therefore asks the one question that predicts that outcome: is the
// user's PHONE country one Bridge can serve? The phone country comes from
// Twilio Lookup at signup (`user.phoneMetadata.countryCode`) — the hardest
// signal to fake (the wave typed "Jamaica" into the address form while
// verifying real Indian and Nigerian SIMs). The allowed set is the config
// list, or — once `countryAllowlist.source` is flipped to "erpnext" — the
// ops-managed ERPNext "Allowed Country" doctype (flash_allowed = 1) with the
// config list as the fallback when ERPNext cannot be read.
//
// Deliberately NO account-age rule: a real user must be able to start KYC the
// moment they sign up (Jabari, 2026-09-01).
//
// Rules are independent and each can be switched off in config
// (`requireVerifiedEmail: false`, `countryAllowlist.enabled: false`). Email is
// checked first when enabled: it is the one the user can act on immediately.

export type BridgeKycGateError =
  | BridgeKycEmailNotVerifiedError
  | BridgeKycCountryNotSupportedError
  | BridgeKycPhoneRequiredError

export type BridgeKycGateRule =
  | "email-not-verified"
  | "country-not-supported"
  | "phone-required"

/** Where a user's phone country came from — stamped on the span so ops can see how often each path fires. */
export type PhoneCountrySource = "lookup" | "number" | "calling-code" | "none"

export type PhoneCountryResolution = {
  /** Candidate ISO alpha-2 codes, upper-case. Empty when nothing could be resolved. */
  countries: string[]
  source: PhoneCountrySource
  /** Only for `source: "calling-code"`: the calling code the candidates were derived from (no "+"). */
  callingCode?: string
}

const NONE: PhoneCountryResolution = { countries: [], source: "none" }

/**
 * The user's phone country (or countries) as upper-case ISO alpha-2.
 *
 * Prefers the Twilio Lookup country stamped at signup. Falls back to parsing
 * the number: its region when libphonenumber can name one, otherwise every
 * region the calling code could denote. That last step matters: ~340
 * assigned NANP area codes are absent from the pinned metadata (+1 924,
 * +1 472, +1 861…), so a US number on one of them parses with no region.
 * Such a user has a verified phone on file; telling them to "add and verify
 * a phone number" is an instruction they cannot act on. The auth
 * destination check (request-code.ts) makes the same fallback.
 */
export const resolvePhoneCountries = (
  user: Pick<User, "phoneMetadata" | "phone"> | undefined,
): PhoneCountryResolution => {
  if (!user) return NONE

  const fromLookup = toAlpha2(user.phoneMetadata?.countryCode)
  if (fromLookup) return { countries: [fromLookup], source: "lookup" }

  if (!user.phone) return NONE
  const parsed = parsePhoneNumberFromString(user.phone)
  if (!parsed) return NONE

  const fromNumber = toAlpha2(parsed.country)
  if (fromNumber) return { countries: [fromNumber], source: "number" }

  const callingCode = parsed.countryCallingCode
  const candidates = countriesForCallingCode(callingCode)
    .map(toAlpha2)
    .filter((code): code is string => code !== undefined)
  if (candidates.length === 0) return NONE
  return { countries: candidates, source: "calling-code", callingCode }
}

/** English display name for an alpha-2 code, or undefined if the runtime cannot name it. */
export const countryDisplayName = (countryCode: string): string | undefined => {
  try {
    const name = new Intl.DisplayNames(["en"], { type: "region" }).of(countryCode)
    // ICU answers "Unknown Region" (not undefined) for a code it cannot name.
    return name && name !== countryCode && !/^unknown/i.test(name) ? name : undefined
  } catch {
    return undefined
  }
}

// Message inputs for a denial. One resolved country names itself. A
// calling-code candidate set is named in full when short ("Kazakhstan or
// Russia"); past that the user gets the generic wording and ops get the codes.
const MAX_NAMED_CANDIDATES = 3

const describeDeniedCountries = (
  countryCodes: readonly string[],
): { countryCode: string; countryName: string | undefined } => {
  if (countryCodes.length === 1) {
    const [countryCode] = countryCodes
    return { countryCode, countryName: countryDisplayName(countryCode) }
  }
  return {
    countryCode: countryCodes.join("/"),
    countryName:
      countryCodes.length <= MAX_NAMED_CANDIDATES
        ? countryCodes.map((code) => countryDisplayName(code) ?? code).join(" or ")
        : "your country",
  }
}

export const checkBridgeKycEligibility = ({
  identity,
  phoneCountries,
  allowedCountries,
  config,
}: {
  identity: Pick<AnyIdentity, "emailVerified"> | undefined
  /** Candidate phone countries (see resolvePhoneCountries). Empty = unresolved. */
  phoneCountries: readonly string[]
  allowedCountries: ReadonlySet<string>
  config: BridgeKycGateConfig
}): true | BridgeKycGateError => {
  if (config.requireVerifiedEmail && identity?.emailVerified !== true) {
    return new BridgeKycEmailNotVerifiedError()
  }

  if (config.countryAllowlist.enabled) {
    if (phoneCountries.length === 0) return new BridgeKycPhoneRequiredError()
    const countryCodes = phoneCountries.map((code) => code.toUpperCase())
    // Any allowed candidate passes. The candidate set is wider than one
    // country only for a number libphonenumber could not attribute, which in
    // practice is a US number on an area code the pinned metadata lacks;
    // with US allowed, denying it would refuse a real US user. The trade is
    // that an unattributable number on a calling code shared between an
    // allowed and a disallowed region (+44: GB vs GG/IM/JE) passes — none of
    // those pairings is an attack origin.
    if (!countryCodes.some((code) => allowedCountries.has(code))) {
      return new BridgeKycCountryNotSupportedError(describeDeniedCountries(countryCodes))
    }
  }

  return true
}

const ruleFor = (error: BridgeKycGateError): BridgeKycGateRule => {
  if (error instanceof BridgeKycEmailNotVerifiedError) return "email-not-verified"
  if (error instanceof BridgeKycPhoneRequiredError) return "phone-required"
  return "country-not-supported"
}

// Span/log label for the phone country: the code when there is one, the
// calling code when only that is known, "unknown" otherwise.
const countryLabel = ({ countries, callingCode }: PhoneCountryResolution): string => {
  if (callingCode !== undefined) return `+${callingCode}`
  return countries[0] ?? "unknown"
}

// Resolver-facing wrapper: gathers the inputs (Kratos identity only when the
// email rule is on; the allowlist only when the country rule is on) and
// applies the pure check. A Kratos lookup failure is returned, not thrown, so
// the caller answers it like any other error. Every denial is logged and
// stamped on the current span so ops can count them per rule and country;
// the country source is stamped on every evaluation so the calling-code
// fallback rate is visible.
export const assertBridgeKycEligible = async ({
  account,
  user,
  config,
}: {
  account: Pick<Account, "id" | "kratosUserId">
  user: Pick<User, "phoneMetadata" | "phone"> | undefined
  config: BridgeKycGateConfig
}): Promise<true | BridgeKycGateError | KratosError> => {
  let identity: Pick<AnyIdentity, "emailVerified"> | undefined
  if (config.requireVerifiedEmail) {
    const loaded = await IdentityRepository().getIdentity(account.kratosUserId)
    if (loaded instanceof Error) return loaded
    identity = loaded
  }

  const resolution = resolvePhoneCountries(user)
  const allowedCountries = config.countryAllowlist.enabled
    ? await getAllowedCountries({
        source: config.countryAllowlist.source,
        fallback: config.countryAllowlist.defaultCountries,
      })
    : new Set<string>()

  addAttributesToCurrentSpan({ "bridge.kyc_gate.country_source": resolution.source })

  const result = checkBridgeKycEligibility({
    identity,
    phoneCountries: resolution.countries,
    allowedCountries,
    config,
  })

  if (result instanceof Error) {
    const rule = ruleFor(result)
    const countryCode = countryLabel(resolution)
    baseLogger.warn(
      { accountId: account.id, countryCode, countrySource: resolution.source, rule },
      "bridge kyc gate denied initiation",
    )
    addAttributesToCurrentSpan({
      "bridge.kyc_gate.denied": true,
      "bridge.kyc_gate.rule": rule,
      "bridge.kyc_gate.country": countryCode,
    })
  }

  return result
}
