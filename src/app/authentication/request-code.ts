import {
  TWILIO_ACCOUNT_SID,
  UNSECURE_DEFAULT_LOGIN_CODE,
  getGeetestConfig,
  getSmsAuthUnsupportedCountries,
  getTestAccounts,
  getWhatsAppAuthUnsupportedCountries,
} from "@config"
import { TestAccountsChecker } from "@domain/accounts/test-accounts-checker"
import { isAuthChannelSupportedForCountry } from "@domain/authentication"
import { PhoneAlreadyExistsError } from "@domain/authentication/errors"
import { PhoneCountryNotAllowedError } from "@domain/users/errors"
import { InvalidPhoneNumber, NotImplementedError } from "@domain/errors"
import { RateLimitConfig } from "@domain/rate-limit"
import { RateLimiterExceededError } from "@domain/rate-limit/errors"
import { notifyOpsEvent } from "@services/alerts/ops-events"
import Geetest from "@services/geetest"
import { AuthWithEmailPasswordlessService } from "@services/kratos"
import { baseLogger } from "@services/logger"
import { UsersRepository } from "@services/mongoose"
import { consumeLimiter } from "@services/rate-limit"
import { TWILIO_ACCOUNT_TEST, TwilioClient } from "@services/twilio"
import { parsePhoneNumberFromString } from "libphonenumber-js"

export const requestPhoneCodeWithCaptcha = async ({
  phone,
  geetestChallenge,
  geetestValidate,
  geetestSeccode,
  ip,
  channel,
}: {
  phone: PhoneNumber
  geetestChallenge: string
  geetestValidate: string
  geetestSeccode: string
  ip: IpAddress
  channel: ChannelType
}): Promise<true | ApplicationError> => {
  const geeTestConfig = getGeetestConfig()
  const geetest = Geetest(geeTestConfig)

  const verifySuccess = await geetest.validate(
    geetestChallenge,
    geetestValidate,
    geetestSeccode,
  )
  if (verifySuccess instanceof Error) return verifySuccess

  {
    const limitOk = await checkRequestCodeAttemptPerIpLimits(ip)
    if (limitOk instanceof Error) return limitOk
  }

  {
    const limitOk = await checkRequestCodeAttemptPerLoginIdentifierLimits(phone)
    if (limitOk instanceof Error) return limitOk
  }

  if (UNSECURE_DEFAULT_LOGIN_CODE) {
    return true
  }

  if (TWILIO_ACCOUNT_SID === TWILIO_ACCOUNT_TEST) {
    return new NotImplementedError()
  }

  const testAccounts = getTestAccounts()
  if (TestAccountsChecker(testAccounts).isPhoneValid(phone)) {
    return true
  }

  // Login and signup share this entry point, so an existing account keeps its
  // ability to receive a login code even if its country is on the block list.
  const destinationOk = await checkAuthCodeDestination({
    phone,
    channel,
    allowExistingUser: true,
  })
  if (destinationOk instanceof Error) return destinationOk

  return TwilioClient().initiateVerify({ to: phone, channel })
}

export const requestPhoneCodeForAuthedUser = async ({
  phone,
  ip,
  channel,
  user,
}: {
  phone: PhoneNumber
  ip: IpAddress
  channel: ChannelType
  user: User
}): Promise<
  true | PhoneProviderServiceError | PhoneCountryNotAllowedError | InvalidPhoneNumber
> => {
  {
    const limitOk = await checkRequestCodeAttemptPerIpLimits(ip)
    if (limitOk instanceof Error) return limitOk
  }

  {
    const limitOk = await checkRequestCodeAttemptPerLoginIdentifierLimits(phone)
    if (limitOk instanceof Error) return limitOk
  }

  if (user.phone) {
    return new PhoneAlreadyExistsError()
  }

  if (UNSECURE_DEFAULT_LOGIN_CODE) {
    return true
  }

  if (TWILIO_ACCOUNT_SID === TWILIO_ACCOUNT_TEST) {
    return new NotImplementedError()
  }

  const testAccounts = getTestAccounts()
  if (TestAccountsChecker(testAccounts).isPhoneValid(phone)) {
    return true
  }

  // Binding a phone to an already-authenticated account is always a new
  // registration of that number, so there is no existing-user carve-out here.
  const destinationOk = await checkAuthCodeDestination({ phone, channel })
  if (destinationOk instanceof Error) return destinationOk

  const verifyResp = await TwilioClient().initiateVerify({ to: phone, channel })
  if (!(verifyResp instanceof Error)) {
    notifyOpsEvent({
      flow: "verification",
      phase: "otp-sent",
      status: "pending",
      userId: user.id,
      phone,
    })
  }
  return verifyResp
}

export const requestEmailCode = async ({
  email,
  ip,
}: {
  email: EmailAddress
  ip: IpAddress
}): Promise<EmailLoginId | EmailRegistrationId | KratosError> => {
  baseLogger.info({ email, ip }, "RequestEmailCode called")

  {
    const limitOk = await checkRequestCodeAttemptPerIpLimits(ip)
    if (limitOk instanceof Error) return limitOk
  }

  {
    const limitOk = await checkRequestCodeAttemptPerLoginIdentifierLimits(email)
    if (limitOk instanceof Error) return limitOk
  }

  const authServiceEmail = AuthWithEmailPasswordlessService()
  const flow = await authServiceEmail.sendEmailWithCode({ email })
  if (flow instanceof Error) return flow

  return flow
}

// Blocked destinations are the whole point of the control, so they have to be
// observable: without this you cannot answer "is the gate firing", "what did it
// save", or "is it hitting real users in TR" without a redeploy.
const reportBlockedDestination = ({
  phone,
  channel,
  countryCode,
}: {
  phone: PhoneNumber
  channel: ChannelType
  countryCode?: string
}): void => {
  baseLogger.warn({ countryCode, channel }, "auth code destination blocked")
  notifyOpsEvent({
    flow: "verification",
    phase: "destination-blocked",
    status: "failed",
    phone,
    error: countryCode ? PhoneCountryNotAllowedError.name : InvalidPhoneNumber.name,
    meta: { channel: String(channel), country: countryCode ?? "unknown" },
  })
}

const phoneBelongsToExistingUser = async (phone: PhoneNumber): Promise<boolean> => {
  const user = await UsersRepository().findByPhone(phone)
  // Any repository failure falls through to the block: the fraud control fails
  // closed, never open.
  return !(user instanceof Error)
}

// Rejects auth-code destinations before any Twilio spend. Countries are billed
// per message whether or not a human is behind the request, so an unsupported
// destination must never reach the provider.
const checkAuthCodeDestination = async ({
  phone,
  channel,
  allowExistingUser = false,
}: {
  phone: PhoneNumber
  channel: ChannelType
  allowExistingUser?: boolean
}): Promise<true | PhoneCountryNotAllowedError | InvalidPhoneNumber> => {
  // Callers hand us the raw channel string in at least one path
  // (POST /auth/phone/code does not lowercase it), and the supported-country
  // lookup branches on the exact value. Normalize once, here, so every caller
  // is gated against the list it actually asked for.
  const normalizedChannel = String(channel).toLowerCase() as ChannelType

  const countryCode = parsePhoneNumberFromString(phone)?.country
  if (countryCode === undefined) {
    reportBlockedDestination({ phone, channel: normalizedChannel })
    // The country is unknown, not disallowed — say so, or the log line and the
    // client-facing error both misattribute a malformed number to the gate.
    return new InvalidPhoneNumber(phone)
  }

  const supported = isAuthChannelSupportedForCountry({
    countryCode: countryCode as CountryCode,
    channel: normalizedChannel,
    unsupportedSmsCountries: getSmsAuthUnsupportedCountries(),
    unsupportedWhatsAppCountries: getWhatsAppAuthUnsupportedCountries(),
  })
  if (supported) return true

  if (allowExistingUser && (await phoneBelongsToExistingUser(phone))) {
    baseLogger.info(
      { countryCode, channel: normalizedChannel },
      "auth code destination in a blocked country allowed for an existing user",
    )
    return true
  }

  reportBlockedDestination({ phone, channel: normalizedChannel, countryCode })
  return new PhoneCountryNotAllowedError()
}

const checkRequestCodeAttemptPerIpLimits = async (
  ip: IpAddress,
): Promise<true | RateLimiterExceededError> =>
  consumeLimiter({
    rateLimitConfig: RateLimitConfig.requestCodeAttemptPerIp,
    keyToConsume: ip,
  })

const checkRequestCodeAttemptPerLoginIdentifierLimits = async (
  loginIdentifier: LoginIdentifier,
): Promise<true | RateLimiterExceededError> =>
  consumeLimiter({
    rateLimitConfig: RateLimitConfig.requestCodeAttemptPerLoginIdentifier,
    keyToConsume: loginIdentifier,
  })
