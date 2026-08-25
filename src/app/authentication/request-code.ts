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
import {
  IdentifierNotFoundError,
  PhoneAlreadyExistsError,
} from "@domain/authentication/errors"
import { PhoneCountryNotAllowedError } from "@domain/users/errors"
import { InvalidPhoneNumber, NotImplementedError } from "@domain/errors"
import { ChannelType } from "@domain/phone-provider"
import { RateLimitConfig } from "@domain/rate-limit"
import { RateLimiterExceededError } from "@domain/rate-limit/errors"
import { notifyOpsEvent } from "@services/alerts/ops-events"
import Geetest from "@services/geetest"
import { AuthWithEmailPasswordlessService, IdentityRepository } from "@services/kratos"
import { baseLogger } from "@services/logger"
import { RedisRateLimitService, consumeLimiter } from "@services/rate-limit"
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
    ip,
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
//
// The trigger is attacker-controlled and free, though, and notifyOpsEvent feeds
// a single 50-slot FIFO shared with cashout/deposit/upgrade/transfer that drops
// its OLDEST entries on overflow. One embed per rejection would evict the rest
// of the ops feed during exactly the incident this telemetry exists to
// illuminate. So the first rejection of each kind pages immediately — a new
// attack origin is still news the moment it appears — and everything after it
// is counted and flushed as one summary per window.

const BLOCKED_REPORT_WINDOW_MS = 5 * 60 * 1000
const BLOCKED_REPORT_WINDOW_LABEL = `${BLOCKED_REPORT_WINDOW_MS / 60_000}m`

type BlockedPhase =
  | "destination-blocked"
  | "destination-blocked-existing-user"
  | "destination-blocked-probe-limit"

const BLOCKED_LOG_MESSAGE: Record<BlockedPhase, string> = {
  "destination-blocked": "auth code destination blocked",
  "destination-blocked-existing-user":
    "auth code destination in a blocked country allowed for an existing user",
  "destination-blocked-probe-limit":
    "auth code existing-user probe budget exhausted for a blocked country",
}

type BlockedReport = {
  phone: PhoneNumber
  channel: ChannelType
  countryCode?: string
  phase?: BlockedPhase
  status?: "pending" | "failed"
  error?: string
}

type BlockedBucket = {
  phase: BlockedPhase
  status: "pending" | "failed"
  channel: ChannelType
  countryCode?: string
  error?: string
  count: number
}

const pendingBlockedReports: Map<string, BlockedBucket> = new Map()
const pagedBlockedKinds: Set<string> = new Set()
let blockedReportTimer: NodeJS.Timeout | undefined

/**
 * Emits one summary event per (phase, channel, country) seen since the last
 * flush. Exported so the interval is not the only way to drain it (tests).
 */
export const flushBlockedDestinationReports = (): void => {
  for (const bucket of pendingBlockedReports.values()) {
    notifyOpsEvent({
      flow: "verification",
      phase: bucket.phase,
      status: bucket.status,
      error: bucket.error,
      meta: {
        channel: String(bucket.channel),
        country: bucket.countryCode ?? "unknown",
        count: String(bucket.count),
        window: BLOCKED_REPORT_WINDOW_LABEL,
      },
    })
  }
  pendingBlockedReports.clear()
}

/** Clears all coalescing state. Intended for tests. */
export const resetBlockedDestinationReporting = (): void => {
  pendingBlockedReports.clear()
  pagedBlockedKinds.clear()
  if (blockedReportTimer !== undefined) {
    clearInterval(blockedReportTimer)
    blockedReportTimer = undefined
  }
}

const scheduleBlockedReportFlush = (): void => {
  if (blockedReportTimer !== undefined) return
  blockedReportTimer = setInterval(
    flushBlockedDestinationReports,
    BLOCKED_REPORT_WINDOW_MS,
  )
  // A telemetry timer must never be the reason the process stays alive.
  blockedReportTimer.unref?.()
}

const reportBlockedDestination = ({
  phone,
  channel,
  countryCode,
  phase = "destination-blocked",
  status = "failed",
  error,
}: BlockedReport): void => {
  const logPayload = { countryCode, channel }
  if (status === "failed") {
    baseLogger.warn(logPayload, BLOCKED_LOG_MESSAGE[phase])
  } else {
    baseLogger.info(logPayload, BLOCKED_LOG_MESSAGE[phase])
  }

  const key = `${phase}|${channel}|${countryCode ?? "unknown"}`

  const bucket = pendingBlockedReports.get(key)
  if (bucket) {
    bucket.count += 1
    return
  }

  if (!pagedBlockedKinds.has(key)) {
    pagedBlockedKinds.add(key)
    notifyOpsEvent({
      flow: "verification",
      phase,
      status,
      phone,
      error,
      meta: { channel: String(channel), country: countryCode ?? "unknown" },
    })
    return
  }

  // Summaries aggregate many numbers, so they carry no phone.
  pendingBlockedReports.set(key, {
    phase,
    status,
    channel,
    countryCode,
    error,
    count: 1,
  })
  scheduleBlockedReportFlush()
}

// Whether a number can actually log in is decided by Kratos, not Mongo:
// login.ts resolves the identity with getUserIdFromIdentifier and, when it
// resolves, skips onboarding entirely. The two stores are filled by a two-phase
// write with no reconciliation — the identity exists before the /registration
// webhook runs, and that webhook can fail — so asking Mongo would refuse a
// login code to accounts that log in fine today, which is the exact lockout
// this carve-out exists to prevent.
const phoneBelongsToExistingUser = async (phone: PhoneNumber): Promise<boolean> => {
  const userId = await IdentityRepository().getUserIdFromIdentifier(phone)
  if (userId instanceof IdentifierNotFoundError) return false
  if (userId instanceof Error) {
    // A Kratos fault is not evidence of absence, but the fraud control fails
    // closed, never open.
    baseLogger.warn(
      { error: userId.name },
      "kratos identity lookup failed for the auth code destination gate",
    )
    return false
  }
  return true
}

const rewardRequestCodeBlockedCountryPerIp = async (ip: IpAddress): Promise<void> => {
  const limiter = RedisRateLimitService({
    keyPrefix: RateLimitConfig.requestCodeBlockedCountryPerIp.key,
    limitOptions: RateLimitConfig.requestCodeBlockedCountryPerIp.limits,
  })
  const rewarded = await limiter.reward(ip)
  // The refund is what keeps the carve-out honest: without it, a real customer
  // abroad spends their own budget every time they ask. `reward` RETURNS its
  // error rather than throwing, so swallowing it means a Redis fault silently
  // turns "never spent out of their own login code" into a claim that is only
  // true while Redis is healthy — and the resulting lockout has nothing in the
  // logs tying it back here.
  if (rewarded instanceof Error) {
    baseLogger.warn(
      { error: rewarded.name },
      "blocked-country probe budget refund failed",
    )
  }
}

type CarveOutResult = "allowed" | "no-such-user" | "probe-budget-exhausted"

// The carve-out answers "does this number hold a Flash account" without sending
// anything, so probing it is free — the economic brake that bounds every other
// enumeration attempt on this endpoint does not exist here. A tiny per-IP budget
// is consumed BEFORE the lookup so a sweep runs out after a couple of tries; a
// confirmed account refunds its point, so a real customer abroad is never spent
// out of their own login code by asking twice.
const allowBlockedCountryForExistingUser = async ({
  phone,
  ip,
  channel,
  countryCode,
}: {
  phone: PhoneNumber
  ip: IpAddress
  channel: ChannelType
  countryCode: string
}): Promise<CarveOutResult> => {
  const budgetOk = await consumeLimiter({
    rateLimitConfig: RateLimitConfig.requestCodeBlockedCountryPerIp,
    keyToConsume: ip,
  })
  // Exhausted budget and limiter faults alike fall through to the block: the
  // control fails closed, never open.
  if (budgetOk instanceof Error) return "probe-budget-exhausted"

  if (!(await phoneBelongsToExistingUser(phone))) return "no-such-user"

  await rewardRequestCodeBlockedCountryPerIp(ip)
  // Real users served by the carve-out are the signal the block list is tuned
  // on. Reporting them locally only would guarantee the feed reads "no real
  // users here" no matter how many there are, and no country would ever be
  // pruned on its evidence.
  reportBlockedDestination({
    phone,
    channel,
    countryCode,
    phase: "destination-blocked-existing-user",
    status: "pending",
  })
  return "allowed"
}

// Rejects auth-code destinations before any Twilio spend. Countries are billed
// per message whether or not a human is behind the request, so an unsupported
// destination must never reach the provider.
const checkAuthCodeDestination = async ({
  phone,
  channel,
  ip,
  allowExistingUser = false,
}: {
  phone: PhoneNumber
  channel: ChannelType
  // Only needed for the existing-user carve-out, which is budgeted per IP.
  ip?: IpAddress
  allowExistingUser?: boolean
}): Promise<true | PhoneCountryNotAllowedError | InvalidPhoneNumber> => {
  // Callers hand us the raw channel string in at least one path
  // (POST /auth/phone/code passes `req.body.channel` through unvalidated), and
  // the supported-country lookup branches on the exact value. Normalize once,
  // here, so every caller is gated against the list it actually asked for.
  //
  // Collapsed to the ENUM, not merely lowercased. A lowercase cast leaves the
  // value attacker-controlled, and it is baked into the coalescing key below
  // (`${phase}|${channel}|${countryCode}`) — so every distinct string is a
  // fresh "kind" that misses `pagedBlockedKinds`, pages the ops feed
  // immediately, and adds a permanent Set entry in a long-lived process.
  // `isAuthChannelSupportedForCountry` already treats anything that is not
  // whatsapp as SMS, so collapsing here changes no gating decision — it only
  // bounds the key space to two values.
  const normalizedChannel: ChannelType =
    String(channel).toLowerCase() === ChannelType.Whatsapp
      ? ChannelType.Whatsapp
      : ChannelType.Sms

  const countryCode = parsePhoneNumberFromString(phone)?.country
  if (countryCode === undefined) {
    reportBlockedDestination({
      phone,
      channel: normalizedChannel,
      error: InvalidPhoneNumber.name,
    })
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

  let phase: BlockedPhase = "destination-blocked"
  if (allowExistingUser && ip !== undefined) {
    const carveOut = await allowBlockedCountryForExistingUser({
      phone,
      ip,
      channel: normalizedChannel,
      countryCode,
    })
    if (carveOut === "allowed") return true
    // The caller still gets PhoneCountryNotAllowedError either way — only the
    // feed learns that this rejection was a burnt-out probe budget.
    if (carveOut === "probe-budget-exhausted") phase = "destination-blocked-probe-limit"
  }

  reportBlockedDestination({
    phone,
    channel: normalizedChannel,
    countryCode,
    phase,
    error: PhoneCountryNotAllowedError.name,
  })
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
