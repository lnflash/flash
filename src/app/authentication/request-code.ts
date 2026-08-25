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
import { NotImplementedError } from "@domain/errors"
import { RateLimitConfig } from "@domain/rate-limit"
import { RateLimiterExceededError } from "@domain/rate-limit/errors"
import { notifyOpsEvent } from "@services/alerts/ops-events"
import Geetest from "@services/geetest"
import { AuthWithEmailPasswordlessService } from "@services/kratos"
import { baseLogger } from "@services/logger"
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

  const destinationOk = checkAuthCodeDestination({ phone, channel })
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
}): Promise<true | PhoneProviderServiceError | PhoneCountryNotAllowedError> => {
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

  const destinationOk = checkAuthCodeDestination({ phone, channel })
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

// Rejects auth-code destinations before any Twilio spend. Countries are billed
// per message whether or not a human is behind the request, so an unsupported
// destination must never reach the provider.
const checkAuthCodeDestination = ({
  phone,
  channel,
}: {
  phone: PhoneNumber
  channel: ChannelType
}): true | PhoneCountryNotAllowedError => {
  const countryCode = parsePhoneNumberFromString(phone)?.country
  if (countryCode === undefined) return new PhoneCountryNotAllowedError()

  const supported = isAuthChannelSupportedForCountry({
    countryCode: countryCode as CountryCode,
    channel,
    unsupportedSmsCountries: getSmsAuthUnsupportedCountries(),
    unsupportedWhatsAppCountries: getWhatsAppAuthUnsupportedCountries(),
  })
  if (!supported) return new PhoneCountryNotAllowedError()

  return true
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
