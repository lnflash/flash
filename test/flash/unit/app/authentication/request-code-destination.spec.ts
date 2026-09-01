const mockInitiateVerify = jest.fn()
const mockGeetestValidate = jest.fn()
const mockSmsBlocked = jest.fn(() => [] as string[])
const mockWhatsAppBlocked = jest.fn(() => [] as string[])
const mockGetUserIdFromIdentifier = jest.fn()
const mockConsumeLimiter = jest.fn()
const mockRewardLimiter = jest.fn()

jest.mock("@config", () => {
  const limits = { points: 100, duration: 60, blockDuration: 60 }
  return {
    TWILIO_ACCOUNT_SID: "AC-live",
    UNSECURE_DEFAULT_LOGIN_CODE: undefined,
    getGeetestConfig: jest.fn(() => ({})),
    getTestAccounts: jest.fn(() => []),
    getConsentLogAttemptLimits: jest.fn(() => limits),
    getFailedLoginAttemptPerIpLimits: jest.fn(() => limits),
    getFailedLoginAttemptPerLoginIdentifierLimits: jest.fn(() => limits),
    getInvoiceCreateAttemptLimits: jest.fn(() => limits),
    getInvoiceCreateForRecipientAttemptLimits: jest.fn(() => limits),
    getInviteCreateAttemptLimits: jest.fn(() => limits),
    getInviteTargetAttemptLimits: jest.fn(() => limits),
    getFygaroCheckoutCreateAttemptLimits: jest.fn(() => limits),
    getFygaroTopupAllowanceAttemptLimits: jest.fn(() => limits),
    getOnChainAddressCreateAttemptLimits: jest.fn(() => limits),
    getRequestCodePerIpLimits: jest.fn(() => limits),
    getRequestCodePerLoginIdentifierLimits: jest.fn(() => limits),
    // Mirrors the real getter exactly; test/flash/unit/config/rate-limits.spec.ts
    // is what pins those values.
    getRequestCodeBlockedCountryPerIpLimits: jest.fn(() => ({
      points: 5,
      duration: 3600,
      blockDuration: 3600,
    })),
    getSmsAuthBlockedCountries: () => mockSmsBlocked(),
    getWhatsAppAuthBlockedCountries: () => mockWhatsAppBlocked(),
  }
})

jest.mock("@services/geetest", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    validate: (...args: unknown[]) => mockGeetestValidate(...args),
  })),
}))

jest.mock("@services/rate-limit", () => ({
  consumeLimiter: (...args: unknown[]) => mockConsumeLimiter(...args),
  RedisRateLimitService: jest.fn(() => ({
    consume: jest.fn(async () => true),
    reset: jest.fn(async () => true),
    reward: (...args: unknown[]) => mockRewardLimiter(...args),
  })),
}))

jest.mock("@services/twilio", () => ({
  TWILIO_ACCOUNT_TEST: "AC-test",
  TwilioClient: jest.fn(() => ({
    initiateVerify: (...args: unknown[]) => mockInitiateVerify(...args),
  })),
}))

jest.mock("@services/alerts/ops-events", () => ({
  notifyOpsEvent: jest.fn().mockResolvedValue(undefined),
  opsEventsSettled: jest.fn().mockResolvedValue(undefined),
}))

jest.mock("@services/kratos", () => ({
  AuthWithEmailPasswordlessService: jest.fn(() => ({
    sendEmailWithCode: jest.fn(),
  })),
  IdentityRepository: jest.fn(() => ({
    getUserIdFromIdentifier: (...args: unknown[]) => mockGetUserIdFromIdentifier(...args),
  })),
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import {
  BLOCKED_REPORT_WINDOW_MS,
  flushBlockedDestinationReports,
  requestPhoneCodeForAuthedUser,
  requestPhoneCodeWithCaptcha,
  resetBlockedDestinationReporting,
} from "@app/authentication/request-code"
import { IdentifierNotFoundError } from "@domain/authentication/errors"
import { PhoneCountryNotAllowedError } from "@domain/users/errors"
import { InvalidPhoneNumber } from "@domain/errors"
import { RateLimitPrefix } from "@domain/rate-limit"
import { UserCodeAttemptBlockedCountryIpRateLimiterExceededError } from "@domain/rate-limit/errors"
import { notifyOpsEvent } from "@services/alerts/ops-events"
import { baseLogger } from "@services/logger"

const captcha = {
  geetestChallenge: "challenge",
  geetestValidate: "validate",
  geetestSeccode: "seccode",
}

const requestCode = (phone: string, channel: string) =>
  requestPhoneCodeWithCaptcha({
    phone: phone as PhoneNumber,
    ...captcha,
    ip: "1.2.3.4" as IpAddress,
    channel: channel as ChannelType,
  })

const JAMAICA = "+18761234567"
const UZBEKISTAN = "+998901234567"
const TURKEY = "+905321234567"
// In-service US overlay (+1 983). 340 of the 800 assigned NANP area codes are
// absent from the pinned libphonenumber-js metadata, so `.country` is undefined
// for it even though the number parses fine.
const US_UNATTRIBUTED_OVERLAY = "+19835551234"
// +7 is shared by RU and KZ, and this one attributes to neither.
const PLUS_SEVEN_UNATTRIBUTED = "+70001234567"

class UnknownKratosError extends Error {}

// The blocked-country probe budget is a distinct bucket from the per-IP
// request-code budget; only the former is exhausted here.
const exhaustProbeBudget = () =>
  mockConsumeLimiter.mockImplementation(
    async ({ rateLimitConfig }: { rateLimitConfig: { key: string } }) =>
      rateLimitConfig.key === RateLimitPrefix.requestCodeBlockedCountryPerIp
        ? new UserCodeAttemptBlockedCountryIpRateLimiterExceededError()
        : true,
  )

const resetMocks = () => {
  jest.clearAllMocks()
  resetBlockedDestinationReporting()
  mockInitiateVerify.mockResolvedValue(true)
  mockSmsBlocked.mockReturnValue([])
  mockWhatsAppBlocked.mockReturnValue([])
  mockConsumeLimiter.mockImplementation(async () => true)
  mockRewardLimiter.mockResolvedValue(true)
  mockGetUserIdFromIdentifier.mockResolvedValue(new IdentifierNotFoundError())
}

describe("requestPhoneCodeWithCaptcha — destination country gate", () => {
  beforeEach(() => {
    resetMocks()
    mockGeetestValidate.mockResolvedValue(true)
  })

  afterAll(resetBlockedDestinationReporting)

  it("sends to a supported country", async () => {
    const result = await requestCode(JAMAICA, "sms")

    expect(result).toBe(true)
    expect(mockInitiateVerify).toHaveBeenCalledWith({ to: JAMAICA, channel: "sms" })
  })

  it("never reaches the provider for an unsupported country", async () => {
    mockSmsBlocked.mockReturnValue(["UZ"])

    const result = await requestCode(UZBEKISTAN, "sms")

    expect(result).toBeInstanceOf(PhoneCountryNotAllowedError)
    expect(mockInitiateVerify).not.toHaveBeenCalled()
  })

  it("gates each channel against its own list", async () => {
    mockSmsBlocked.mockReturnValue([])
    mockWhatsAppBlocked.mockReturnValue(["UZ"])

    const viaWhatsApp = await requestCode(UZBEKISTAN, "whatsapp")
    expect(viaWhatsApp).toBeInstanceOf(PhoneCountryNotAllowedError)
    expect(mockInitiateVerify).not.toHaveBeenCalled()

    const viaSms = await requestCode(UZBEKISTAN, "sms")
    expect(viaSms).toBe(true)
    expect(mockInitiateVerify).toHaveBeenCalledTimes(1)
  })

  // libphonenumber cannot name a region for every number it parses. Rejecting
  // on that would have killed signup AND login for real US customers on the
  // ~340 NANP area codes the pinned metadata does not carry — for a market that
  // is on no block list at all.
  describe("numbers whose region libphonenumber cannot name", () => {
    it("sends to a NANP overlay the metadata cannot attribute", async () => {
      mockSmsBlocked.mockReturnValue(["UZ", "RU"])

      const result = await requestCode(US_UNATTRIBUTED_OVERLAY, "sms")

      expect(result).toBe(true)
      expect(mockInitiateVerify).toHaveBeenCalledWith({
        to: US_UNATTRIBUTED_OVERLAY,
        channel: "sms",
      })
    })

    // +7 could be RU or KZ. RU is blocked, so the gate must still fail closed.
    it("blocks when any region the calling code could denote is blocked", async () => {
      mockSmsBlocked.mockReturnValue(["RU"])

      const result = await requestCode(PLUS_SEVEN_UNATTRIBUTED, "sms")

      expect(result).toBeInstanceOf(PhoneCountryNotAllowedError)
      expect(mockInitiateVerify).not.toHaveBeenCalled()
    })

    it("sends when none of those regions is blocked", async () => {
      mockSmsBlocked.mockReturnValue(["UZ"])

      const result = await requestCode(PLUS_SEVEN_UNATTRIBUTED, "sms")

      expect(result).toBe(true)
      expect(mockInitiateVerify).toHaveBeenCalled()
    })

    it("reports the calling code, not `unknown`, so ops can tune on it", async () => {
      mockSmsBlocked.mockReturnValue(["RU"])

      await requestCode(PLUS_SEVEN_UNATTRIBUTED, "sms")

      expect(notifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: "destination-blocked",
          meta: expect.objectContaining({ country: "+7" }),
        }),
      )
    })
  })

  it("never reaches the provider for an unparsable number", async () => {
    const result = await requestCode("+000", "sms")

    expect(result).toBeInstanceOf(InvalidPhoneNumber)
    expect(result).not.toBeInstanceOf(PhoneCountryNotAllowedError)
    expect(mockInitiateVerify).not.toHaveBeenCalled()
  })

  it("rejects before the provider even when the captcha passes", async () => {
    mockSmsBlocked.mockReturnValue(["UZ"])

    await requestCode(UZBEKISTAN, "sms")

    expect(mockGeetestValidate).toHaveBeenCalled()
    expect(mockInitiateVerify).not.toHaveBeenCalled()
  })

  // POST /auth/phone/code forwards req.body.channel verbatim ("SMS"/"WHATSAPP"),
  // unlike the GraphQL resolvers. Without normalization a WhatsApp request on
  // that route would be gated against the SMS list.
  it("normalizes the channel casing before picking a list", async () => {
    mockSmsBlocked.mockReturnValue([])
    mockWhatsAppBlocked.mockReturnValue(["UZ"])

    const result = await requestCode(UZBEKISTAN, "WHATSAPP")

    expect(result).toBeInstanceOf(PhoneCountryNotAllowedError)
    expect(mockInitiateVerify).not.toHaveBeenCalled()
  })

  it("matches a lowercase configmap entry", async () => {
    mockSmsBlocked.mockReturnValue(["uz"])

    const result = await requestCode(UZBEKISTAN, "sms")

    expect(result).toBeInstanceOf(PhoneCountryNotAllowedError)
    expect(mockInitiateVerify).not.toHaveBeenCalled()
  })

  // A fraud control aimed at unregistered traffic must not permanently lock an
  // existing account out of its own login code.
  it("still sends to an existing user in a blocked country", async () => {
    mockSmsBlocked.mockReturnValue(["UZ"])
    mockGetUserIdFromIdentifier.mockResolvedValue("user-id")

    const result = await requestCode(UZBEKISTAN, "sms")

    expect(result).toBe(true)
    expect(mockInitiateVerify).toHaveBeenCalledWith({
      to: UZBEKISTAN,
      channel: "sms",
    })
  })

  // Whether a number can log in is decided by Kratos, and the Mongo user doc is
  // written afterwards by a webhook that can fail. Asking Mongo would refuse a
  // login code to an account that logs in fine today.
  it("still sends when Kratos knows the number and Mongo does not", async () => {
    mockSmsBlocked.mockReturnValue(["UZ"])
    // No Mongo user record exists at all — the identity is the only evidence.
    mockGetUserIdFromIdentifier.mockResolvedValue("kratos-only-user-id")

    const result = await requestCode(UZBEKISTAN, "sms")

    expect(mockGetUserIdFromIdentifier).toHaveBeenCalledWith(UZBEKISTAN)
    expect(result).toBe(true)
    expect(mockInitiateVerify).toHaveBeenCalledWith({
      to: UZBEKISTAN,
      channel: "sms",
    })
  })

  it("blocks a number Kratos has never seen", async () => {
    mockSmsBlocked.mockReturnValue(["UZ"])
    mockGetUserIdFromIdentifier.mockResolvedValue(new IdentifierNotFoundError())

    const result = await requestCode(UZBEKISTAN, "sms")

    expect(result).toBeInstanceOf(PhoneCountryNotAllowedError)
    expect(mockInitiateVerify).not.toHaveBeenCalled()
  })

  it("fails closed when the identity lookup errors", async () => {
    mockSmsBlocked.mockReturnValue(["UZ"])
    mockGetUserIdFromIdentifier.mockResolvedValue(new UnknownKratosError("kratos down"))

    const result = await requestCode(UZBEKISTAN, "sms")

    expect(result).toBeInstanceOf(PhoneCountryNotAllowedError)
    expect(mockInitiateVerify).not.toHaveBeenCalled()
  })

  // The carve-out answers "does this number hold an account" for free, so it
  // needs a budget of its own — the per-IP request-code budget is far too
  // generous to bound an enumeration sweep that costs the attacker nothing.
  describe("existence-probe budget", () => {
    it("blocks an existing user's number once the probe budget is spent", async () => {
      mockSmsBlocked.mockReturnValue(["UZ"])
      mockGetUserIdFromIdentifier.mockResolvedValue("user-id")
      exhaustProbeBudget()

      const result = await requestCode(UZBEKISTAN, "sms")

      // Same response as any other blocked number: no oracle.
      expect(result).toBeInstanceOf(PhoneCountryNotAllowedError)
      expect(mockInitiateVerify).not.toHaveBeenCalled()
    })

    it("spends the budget before the lookup, so a sweep cannot probe past it", async () => {
      mockSmsBlocked.mockReturnValue(["UZ"])
      exhaustProbeBudget()

      await requestCode(UZBEKISTAN, "sms")

      expect(mockConsumeLimiter).toHaveBeenCalledWith(
        expect.objectContaining({
          rateLimitConfig: expect.objectContaining({
            key: RateLimitPrefix.requestCodeBlockedCountryPerIp,
          }),
          keyToConsume: "1.2.3.4",
        }),
      )
      expect(mockGetUserIdFromIdentifier).not.toHaveBeenCalled()
    })

    it("reports a burnt-out probe budget as its own phase", async () => {
      mockSmsBlocked.mockReturnValue(["UZ"])
      exhaustProbeBudget()

      await requestCode(UZBEKISTAN, "sms")

      expect(notifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({ phase: "destination-blocked-probe-limit" }),
      )
    })

    it("refunds the point for a confirmed account, so a real user is never spent out", async () => {
      mockSmsBlocked.mockReturnValue(["UZ"])
      mockGetUserIdFromIdentifier.mockResolvedValue("user-id")

      await requestCode(UZBEKISTAN, "sms")

      expect(mockRewardLimiter).toHaveBeenCalledWith("1.2.3.4")
    })

    it("does not refund a number that holds no account", async () => {
      mockSmsBlocked.mockReturnValue(["UZ"])

      await requestCode(UZBEKISTAN, "sms")

      expect(mockRewardLimiter).not.toHaveBeenCalled()
    })

    it("never touches the probe budget for a supported country", async () => {
      await requestCode(JAMAICA, "sms")

      expect(mockConsumeLimiter).not.toHaveBeenCalledWith(
        expect.objectContaining({
          rateLimitConfig: expect.objectContaining({
            key: RateLimitPrefix.requestCodeBlockedCountryPerIp,
          }),
        }),
      )
    })
  })

  describe("telemetry", () => {
    it("logs and reports a blocked country", async () => {
      mockSmsBlocked.mockReturnValue(["UZ"])

      await requestCode(UZBEKISTAN, "sms")

      expect(baseLogger.warn).toHaveBeenCalledWith(
        { countryCode: "UZ", channel: "sms" },
        "auth code destination blocked",
      )
      expect(notifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          flow: "verification",
          phase: "destination-blocked",
          status: "failed",
          meta: expect.objectContaining({ country: "UZ", channel: "sms" }),
        }),
      )
    })

    // Client input noise is not a policy rejection. Sharing the
    // `destination-blocked` phase would inflate the very counter the block list
    // is tuned from, and burn that phase's one-shot page on a typo.
    it("reports an unparsable number under its own phase", async () => {
      await requestCode("+000", "sms")

      expect(notifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: "destination-unparsable",
          error: "InvalidPhoneNumber",
          meta: expect.objectContaining({ country: "unknown" }),
        }),
      )
      expect(notifyOpsEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ phase: "destination-blocked" }),
      )
    })

    it("does not spend the blocked-country page on client input noise", async () => {
      mockSmsBlocked.mockReturnValue(["UZ"])

      await requestCode("+000", "sms")
      ;(notifyOpsEvent as jest.Mock).mockClear()

      await requestCode(UZBEKISTAN, "sms")

      expect(notifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: "destination-blocked",
          meta: expect.objectContaining({ country: "UZ" }),
        }),
      )
    })

    it("stays silent when the destination is allowed", async () => {
      await requestCode(JAMAICA, "sms")

      expect(notifyOpsEvent).not.toHaveBeenCalled()
      expect(baseLogger.warn).not.toHaveBeenCalled()
    })

    // The block list is meant to be tuned by watching this feed for real
    // traffic. If the carve-out — which is exactly the real users — reported
    // nothing, the feed could only ever say "no real users here".
    it("reports a carve-out so served real users are visible in the feed", async () => {
      mockSmsBlocked.mockReturnValue(["UZ"])
      mockGetUserIdFromIdentifier.mockResolvedValue("user-id")

      await requestCode(UZBEKISTAN, "sms")

      expect(notifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          flow: "verification",
          phase: "destination-blocked-existing-user",
          status: "pending",
          phone: UZBEKISTAN,
          meta: expect.objectContaining({ country: "UZ", channel: "sms" }),
        }),
      )
    })

    // notifyOpsEvent feeds one 50-slot FIFO shared with cashout/deposit/etc.
    // that drops its OLDEST entries: an embed per rejection would evict the
    // rest of the ops feed during the very incident this telemetry is for.
    describe("coalescing", () => {
      it("pages immediately on the first rejection of a country", async () => {
        mockSmsBlocked.mockReturnValue(["UZ"])

        await requestCode(UZBEKISTAN, "sms")

        expect(notifyOpsEvent).toHaveBeenCalledTimes(1)
      })

      it("emits nothing more for the rest of the window", async () => {
        mockSmsBlocked.mockReturnValue(["UZ"])

        for (let i = 0; i < 20; i++) await requestCode(UZBEKISTAN, "sms")

        expect(baseLogger.warn).toHaveBeenCalledTimes(20)
        expect(notifyOpsEvent).toHaveBeenCalledTimes(1)
      })

      it("does not let an attacker-chosen channel string reopen the pager", async () => {
        mockSmsBlocked.mockReturnValue(["UZ"])

        // POST /auth/phone/code passes req.body.channel through unvalidated, and
        // the channel is part of the coalescing key. Before the channel was
        // collapsed to the enum, each distinct string was a fresh "kind": it
        // missed the paged set, paged immediately, and left a permanent entry
        // behind — 20 requests produced 20 pages into the 50-slot ops feed
        // shared with cashout, deposit, upgrade and transfer.
        for (let i = 0; i < 20; i++) await requestCode(UZBEKISTAN, `sms${i}`)

        expect(notifyOpsEvent).toHaveBeenCalledTimes(1)
      })

      it("flushes the rest as one counted summary", async () => {
        mockSmsBlocked.mockReturnValue(["UZ"])

        for (let i = 0; i < 20; i++) await requestCode(UZBEKISTAN, "sms")
        flushBlockedDestinationReports()

        expect(notifyOpsEvent).toHaveBeenCalledTimes(2)
        expect(notifyOpsEvent).toHaveBeenLastCalledWith(
          expect.objectContaining({
            phase: "destination-blocked",
            meta: expect.objectContaining({ country: "UZ", count: "19" }),
          }),
        )
      })

      // Every other test here drains the buckets by calling
      // flushBlockedDestinationReports() by hand. Nothing exercised the
      // interval that drains it in production, so deleting the
      // scheduleBlockedReportFlush() call left the suite green while the
      // summary embed never fired — ops would page once per country during a
      // flood and never learn the volume.
      describe("the window timer", () => {
        beforeEach(() => jest.useFakeTimers())

        afterEach(() => {
          resetBlockedDestinationReporting()
          jest.useRealTimers()
        })

        it("emits the summary on its own, with no manual flush", async () => {
          mockSmsBlocked.mockReturnValue(["UZ"])

          for (let i = 0; i < 3; i++) await requestCode(UZBEKISTAN, "sms")
          expect(notifyOpsEvent).toHaveBeenCalledTimes(1)

          jest.advanceTimersByTime(BLOCKED_REPORT_WINDOW_MS)

          expect(notifyOpsEvent).toHaveBeenCalledTimes(2)
          expect(notifyOpsEvent).toHaveBeenLastCalledWith(
            expect.objectContaining({
              phase: "destination-blocked",
              meta: expect.objectContaining({ country: "UZ", count: "2" }),
            }),
          )
        })

        it("keeps emitting one summary per window", async () => {
          mockSmsBlocked.mockReturnValue(["UZ"])

          for (let i = 0; i < 3; i++) await requestCode(UZBEKISTAN, "sms")
          jest.advanceTimersByTime(BLOCKED_REPORT_WINDOW_MS)
          ;(notifyOpsEvent as jest.Mock).mockClear()

          for (let i = 0; i < 5; i++) await requestCode(UZBEKISTAN, "sms")
          jest.advanceTimersByTime(BLOCKED_REPORT_WINDOW_MS)

          expect(notifyOpsEvent).toHaveBeenCalledTimes(1)
          expect(notifyOpsEvent).toHaveBeenLastCalledWith(
            expect.objectContaining({
              meta: expect.objectContaining({ country: "UZ", count: "5" }),
            }),
          )
        })

        it("stays quiet while there is nothing pending", async () => {
          await requestCode(JAMAICA, "sms")

          jest.advanceTimersByTime(BLOCKED_REPORT_WINDOW_MS * 4)

          expect(notifyOpsEvent).not.toHaveBeenCalled()
        })
      })

      // Counts that live only in this map are lost on every rolling deploy, pod
      // eviction and OOM kill — and a pod under attack load is the likeliest
      // one to be cycled, so the block list would be tuned from data that is
      // lossiest exactly when it matters.
      describe("shutdown", () => {
        it("drains the pending summaries on SIGTERM", async () => {
          mockSmsBlocked.mockReturnValue(["UZ"])
          const killSpy = jest.spyOn(process, "kill").mockImplementation(() => true)

          try {
            for (let i = 0; i < 3; i++) await requestCode(UZBEKISTAN, "sms")
            ;(notifyOpsEvent as jest.Mock).mockClear()

            process.emit("SIGTERM", "SIGTERM")

            expect(notifyOpsEvent).toHaveBeenCalledWith(
              expect.objectContaining({
                phase: "destination-blocked",
                meta: expect.objectContaining({ country: "UZ", count: "2" }),
              }),
            )

            // A listener on SIGTERM suppresses Node's default terminate, so the
            // handler must hand the signal back or the pod would never exit.
            await new Promise((resolve) => setImmediate(resolve))
            expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGTERM")
            expect(process.listenerCount("SIGTERM")).toBe(0)
          } finally {
            killSpy.mockRestore()
          }
        })

        // The hook is installed on first coalesce, not at import, so a process
        // that never rejects a destination never changes how it dies.
        it("installs no signal listener until something is pending", async () => {
          const before = process.listenerCount("SIGTERM")

          await requestCode(JAMAICA, "sms")

          expect(process.listenerCount("SIGTERM")).toBe(before)
        })

        // Apollo's drain keeps existing keep-alive connections served while it
        // stops, so blocked requests keep arriving after SIGTERM — a flood is
        // the only time this flush is worth having. Re-arming the hook there
        // would make the re-raised signal be caught again, wait the flush
        // timeout again and re-raise again: ~15 loops inside a 30s k8s grace
        // period, then SIGKILL with in-flight requests dropped and the counts
        // lost anyway. The hook is a one-way latch.
        it("does not re-arm when a block lands after the signal", async () => {
          mockSmsBlocked.mockReturnValue(["UZ"])
          const killSpy = jest.spyOn(process, "kill").mockImplementation(() => true)

          try {
            for (let i = 0; i < 3; i++) await requestCode(UZBEKISTAN, "sms")

            process.emit("SIGTERM", "SIGTERM")
            await new Promise((resolve) => setImmediate(resolve))
            expect(process.listenerCount("SIGTERM")).toBe(0)

            // The drain window: more blocked traffic, still coalescing.
            for (let i = 0; i < 5; i++) await requestCode(UZBEKISTAN, "sms")

            expect(process.listenerCount("SIGTERM")).toBe(0)

            // And so the signal is handed back exactly once.
            process.emit("SIGTERM", "SIGTERM")
            await new Promise((resolve) => setImmediate(resolve))
            expect(killSpy).toHaveBeenCalledTimes(1)
          } finally {
            killSpy.mockRestore()
          }
        })
      })

      it("pages a new attack origin immediately even mid-flood", async () => {
        mockSmsBlocked.mockReturnValue(["UZ", "TR"])

        for (let i = 0; i < 20; i++) await requestCode(UZBEKISTAN, "sms")
        ;(notifyOpsEvent as jest.Mock).mockClear()

        await requestCode(TURKEY, "sms")

        expect(notifyOpsEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            phase: "destination-blocked",
            meta: expect.objectContaining({ country: "TR" }),
          }),
        )
      })

      it("counts each country separately", async () => {
        mockSmsBlocked.mockReturnValue(["UZ", "TR"])

        for (let i = 0; i < 3; i++) await requestCode(UZBEKISTAN, "sms")
        for (let i = 0; i < 5; i++) await requestCode(TURKEY, "sms")
        ;(notifyOpsEvent as jest.Mock).mockClear()
        flushBlockedDestinationReports()

        const counts = (notifyOpsEvent as jest.Mock).mock.calls.map(
          ([event]) => `${event.meta.country}:${event.meta.count}`,
        )
        expect(counts.sort()).toEqual(["TR:4", "UZ:2"])
      })

      it("drains its pending summaries, so a flush emits nothing twice", async () => {
        mockSmsBlocked.mockReturnValue(["UZ"])

        for (let i = 0; i < 3; i++) await requestCode(UZBEKISTAN, "sms")
        flushBlockedDestinationReports()
        ;(notifyOpsEvent as jest.Mock).mockClear()
        flushBlockedDestinationReports()

        expect(notifyOpsEvent).not.toHaveBeenCalled()
      })

      // "A new attack origin is still news the moment it appears" only holds if
      // a kind can stop being current. Paged kinds used to live for the pod's
      // lifetime, so the second wave from a country — next week, after a month
      // of silence — arrived as a delayed 5-minute summary and nothing else.
      describe("a kind stops being current once its origin goes quiet", () => {
        const THIRTY_ONE_MINUTES_MS = 31 * 60 * 1000
        const FOUR_MINUTES_MS = 4 * 60 * 1000

        let clock: number
        let nowSpy: jest.SpyInstance<number, []>

        beforeEach(() => {
          clock = Date.now()
          nowSpy = jest.spyOn(Date, "now").mockImplementation(() => clock)
        })

        afterEach(() => nowSpy.mockRestore())

        const advance = (ms: number) => {
          clock += ms
        }

        it("pages again for a wave that arrives after a quiet period", async () => {
          mockSmsBlocked.mockReturnValue(["UZ"])

          for (let i = 0; i < 5; i++) await requestCode(UZBEKISTAN, "sms")
          flushBlockedDestinationReports()

          advance(THIRTY_ONE_MINUTES_MS)
          flushBlockedDestinationReports()
          ;(notifyOpsEvent as jest.Mock).mockClear()

          await requestCode(UZBEKISTAN, "sms")

          expect(notifyOpsEvent).toHaveBeenCalledTimes(1)
          expect(notifyOpsEvent).toHaveBeenCalledWith(
            expect.objectContaining({
              phase: "destination-blocked",
              phone: UZBEKISTAN,
              meta: expect.objectContaining({ country: "UZ" }),
            }),
          )
        })

        it("does not re-page during a sustained flood", async () => {
          mockSmsBlocked.mockReturnValue(["UZ"])

          // 40 minutes of continuous traffic — well past the quiet threshold,
          // but never quiet.
          for (let i = 0; i < 10; i++) {
            await requestCode(UZBEKISTAN, "sms")
            advance(FOUR_MINUTES_MS)
            flushBlockedDestinationReports()
          }
          ;(notifyOpsEvent as jest.Mock).mockClear()

          await requestCode(UZBEKISTAN, "sms")

          expect(notifyOpsEvent).not.toHaveBeenCalled()
        })
      })

      it("coalesces the carve-out on the same terms", async () => {
        mockSmsBlocked.mockReturnValue(["UZ"])
        mockGetUserIdFromIdentifier.mockResolvedValue("user-id")

        for (let i = 0; i < 4; i++) await requestCode(UZBEKISTAN, "sms")
        expect(notifyOpsEvent).toHaveBeenCalledTimes(1)

        flushBlockedDestinationReports()

        expect(notifyOpsEvent).toHaveBeenLastCalledWith(
          expect.objectContaining({
            phase: "destination-blocked-existing-user",
            status: "pending",
            meta: expect.objectContaining({ country: "UZ", count: "3" }),
          }),
        )
      })
    })
  })
})

describe("requestPhoneCodeForAuthedUser — destination country gate", () => {
  const user = { id: "user-id" as UserId, phone: undefined } as unknown as User

  const requestForAuthedUser = (phone: string, channel: string) =>
    requestPhoneCodeForAuthedUser({
      phone: phone as PhoneNumber,
      ip: "1.2.3.4" as IpAddress,
      channel: channel as ChannelType,
      user,
    })

  beforeEach(resetMocks)

  afterAll(resetBlockedDestinationReporting)

  it("sends to a supported country", async () => {
    const result = await requestForAuthedUser(JAMAICA, "sms")

    expect(result).toBe(true)
    expect(mockInitiateVerify).toHaveBeenCalledWith({ to: JAMAICA, channel: "sms" })
  })

  it("never reaches the provider for an unsupported country", async () => {
    mockSmsBlocked.mockReturnValue(["UZ"])

    const result = await requestForAuthedUser(UZBEKISTAN, "sms")

    expect(result).toBeInstanceOf(PhoneCountryNotAllowedError)
    expect(mockInitiateVerify).not.toHaveBeenCalled()
  })

  it("does not fire the otp-sent ops event for a blocked country", async () => {
    mockSmsBlocked.mockReturnValue(["UZ"])

    await requestForAuthedUser(UZBEKISTAN, "sms")

    expect(notifyOpsEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ phase: "otp-sent" }),
    )
    expect(notifyOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "destination-blocked" }),
    )
  })

  it("gates each channel against its own list", async () => {
    mockWhatsAppBlocked.mockReturnValue(["UZ"])

    const viaWhatsApp = await requestForAuthedUser(UZBEKISTAN, "whatsapp")
    expect(viaWhatsApp).toBeInstanceOf(PhoneCountryNotAllowedError)
    expect(mockInitiateVerify).not.toHaveBeenCalled()

    const viaSms = await requestForAuthedUser(UZBEKISTAN, "sms")
    expect(viaSms).toBe(true)
    expect(mockInitiateVerify).toHaveBeenCalledTimes(1)
  })

  it("rejects an unparsable number as invalid", async () => {
    const result = await requestForAuthedUser("+000", "sms")

    expect(result).toBeInstanceOf(InvalidPhoneNumber)
    expect(mockInitiateVerify).not.toHaveBeenCalled()
  })

  // Binding a phone to an authed account registers that number, so an existing
  // record for it must not open a hole in the gate.
  it("has no existing-user carve-out", async () => {
    mockSmsBlocked.mockReturnValue(["UZ"])
    mockGetUserIdFromIdentifier.mockResolvedValue("someone-else")

    const result = await requestForAuthedUser(UZBEKISTAN, "sms")

    expect(result).toBeInstanceOf(PhoneCountryNotAllowedError)
    expect(mockGetUserIdFromIdentifier).not.toHaveBeenCalled()
    expect(mockInitiateVerify).not.toHaveBeenCalled()
  })
})
