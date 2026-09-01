import { parsePhoneNumberFromString } from "libphonenumber-js"

import { getAllowedCountries } from "@services/frappe/allowed-countries"
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
// verifying real Indian and Nigerian SIMs). The allowed set is ops-managed in
// ERPNext ("Allowed Country", flash_allowed = 1), with the config list as the
// fallback when ERPNext cannot be read.
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
  "email-not-verified" | "country-not-supported" | "phone-required"

const ALPHA2 = /^[A-Z]{2}$/

/**
 * The user's phone country as upper-case ISO alpha-2, or undefined. Prefers
 * the Twilio Lookup country stamped at signup; falls back to parsing the
 * phone number itself (region may be undefined for NANP numbers whose area
 * code is missing from the pinned libphonenumber metadata — that is a
 * "phone required" outcome, not a guess).
 */
export const resolvePhoneCountry = (
  user: Pick<User, "phoneMetadata" | "phone"> | undefined,
): string | undefined => {
  if (!user) return undefined

  const fromLookup = user.phoneMetadata?.countryCode
  if (typeof fromLookup === "string") {
    const code = fromLookup.trim().toUpperCase()
    if (ALPHA2.test(code)) return code
  }

  if (user.phone) {
    const parsed = parsePhoneNumberFromString(user.phone)
    if (parsed?.country && ALPHA2.test(parsed.country)) return parsed.country
  }

  return undefined
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

export const checkBridgeKycEligibility = ({
  identity,
  phoneCountry,
  allowedCountries,
  config,
}: {
  identity: Pick<AnyIdentity, "emailVerified"> | undefined
  phoneCountry: string | undefined
  allowedCountries: ReadonlySet<string>
  config: BridgeKycGateConfig
}): true | BridgeKycGateError => {
  if (config.requireVerifiedEmail && identity?.emailVerified !== true) {
    return new BridgeKycEmailNotVerifiedError()
  }

  if (config.countryAllowlist.enabled) {
    if (!phoneCountry) return new BridgeKycPhoneRequiredError()
    const countryCode = phoneCountry.toUpperCase()
    if (!allowedCountries.has(countryCode)) {
      return new BridgeKycCountryNotSupportedError({
        countryCode,
        countryName: countryDisplayName(countryCode),
      })
    }
  }

  return true
}

const ruleFor = (error: BridgeKycGateError): BridgeKycGateRule => {
  if (error instanceof BridgeKycEmailNotVerifiedError) return "email-not-verified"
  if (error instanceof BridgeKycPhoneRequiredError) return "phone-required"
  return "country-not-supported"
}

// Resolver-facing wrapper: gathers the inputs (Kratos identity only when the
// email rule is on; the allowlist only when the country rule is on) and
// applies the pure check. A Kratos lookup failure is returned, not thrown, so
// the caller answers it like any other error. Every denial is logged and
// stamped on the current span so ops can count them per rule and country.
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

  const phoneCountry = resolvePhoneCountry(user)
  const allowedCountries = config.countryAllowlist.enabled
    ? await getAllowedCountries({ fallback: config.countryAllowlist.defaultCountries })
    : new Set<string>()

  const result = checkBridgeKycEligibility({
    identity,
    phoneCountry,
    allowedCountries,
    config,
  })

  if (result instanceof Error) {
    const rule = ruleFor(result)
    baseLogger.warn(
      { accountId: account.id, countryCode: phoneCountry, rule },
      "bridge kyc gate denied initiation",
    )
    addAttributesToCurrentSpan({
      "bridge.kyc_gate.denied": true,
      "bridge.kyc_gate.rule": rule,
      "bridge.kyc_gate.country": phoneCountry ?? "unknown",
    })
  }

  return result
}
