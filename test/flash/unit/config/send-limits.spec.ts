import Ajv from "ajv"
import { RateLimiterMemory, RateLimiterRes } from "rate-limiter-flexible"

import {
  getAccountLimits,
  getPaymentSendAttemptLimits,
  getPaymentSendDailyAttemptLimits,
  getSendGuardMode,
} from "@config"

import { AccountLevel, effectiveAccountLevel } from "@domain/accounts"
import { RateLimitConfig, RateLimitPrefix } from "@domain/rate-limit"
import { PaymentSendRateLimiterExceededError } from "@domain/rate-limit/errors"

import { configSchema } from "../../../../src/config/schema"

// ENG-573 Phase 0. These numbers are what the send guard enforces; none of them
// come from the yaml the unit suite loads, so nothing else pins them.
describe("send-guard config (ENG-573)", () => {
  describe("account limits", () => {
    it("configures every level the domain knows about, including Business (L3)", () => {
      for (const level of [
        AccountLevel.Zero,
        AccountLevel.One,
        AccountLevel.Two,
        AccountLevel.Three,
      ]) {
        const limits = getAccountLimits({ level })
        expect(Number.isFinite(limits.intraLedgerLimit)).toBe(true)
        expect(Number.isFinite(limits.withdrawalLimit)).toBe(true)
        expect(Number.isFinite(limits.tradeIntraAccountLimit)).toBe(true)
      }
    })

    it("gives Business (L3) the level-2 numbers as a placeholder until a ladder is decided", () => {
      expect(getAccountLimits({ level: AccountLevel.Three })).toEqual(
        getAccountLimits({ level: AccountLevel.Two }),
      )
    })

    // ~300 prod account documents have no `level` field at all (174 of them
    // with usernames). The rule that reads that as level 0 lives in ONE place —
    // `effectiveAccountLevel`, applied inside `getAccountLimits` — because
    // every consumer has to agree: `account-limit.ts` and `payments/helpers.ts`
    // pass `account.level` straight through, so a rule applied only inside the
    // send guard meant the guard refused an unleveled user at $125 while
    // `Account.limits` / `remainingLimit` resolved to NaN and the limits screen
    // showed them something else entirely.
    it("resolves an account with no level to the level-0 limits, not to NaN", () => {
      expect(getAccountLimits({ level: undefined })).toEqual(
        getAccountLimits({ level: AccountLevel.Zero }),
      )
    })

    it("resolves it through the shared rule every other consumer uses", () => {
      expect(effectiveAccountLevel(undefined)).toBe(AccountLevel.Zero)
      // ...and leaves a level that IS set alone.
      for (const level of [AccountLevel.One, AccountLevel.Two, AccountLevel.Three]) {
        expect(effectiveAccountLevel(level)).toBe(level)
      }
    })

    // Level 1 deliberately departs from Galoy's split ladder: see the comment
    // on `intraLedger.level.1` in src/config/schema.ts.
    it("keeps the Galoy defaults for levels 0-2, except the settled level-1 limit", () => {
      expect(getAccountLimits({ level: AccountLevel.Zero })).toEqual({
        intraLedgerLimit: 12500,
        withdrawalLimit: 12500,
        tradeIntraAccountLimit: 200000,
      })
      expect(getAccountLimits({ level: AccountLevel.One })).toEqual({
        intraLedgerLimit: 100000,
        withdrawalLimit: 100000,
        tradeIntraAccountLimit: 5000000,
      })
      expect(getAccountLimits({ level: AccountLevel.Two })).toEqual({
        intraLedgerLimit: 5000000,
        withdrawalLimit: 5000000,
        tradeIntraAccountLimit: 20000000,
      })
    })

    // The `accountLimits` block carries ONE default, applied by Ajv only when
    // the key is absent entirely. The moment a values file sets `accountLimits`
    // — the edit ENG-573 explicitly schedules once the L3 ladder is decided —
    // that default is gone and only what the file spells out survives. Levels
    // 0-2 are `required`, so a partial override fails loudly at boot. Level 3
    // must fail the same way: without the `required` entry it resolves to NaN
    // and every Business (L3) account silently loses the ability to send, one
    // account at a time, at runtime.
    it("fails validation at boot when a deployment overrides accountLimits without level 3", () => {
      const validate = new Ajv({ useDefaults: true }).compile({
        type: "object",
        properties: { accountLimits: configSchema.properties.accountLimits },
        required: ["accountLimits"],
      })
      const withoutLevelThree = {
        withdrawal: { level: { 0: 12500, 1: 100000, 2: 5000000 } },
        intraLedger: { level: { 0: 12500, 1: 100000, 2: 5000000 } },
        tradeIntraAccount: { level: { 0: 200000, 1: 5000000, 2: 20000000 } },
      }

      expect(validate({ accountLimits: withoutLevelThree })).toBe(false)
      expect(validate.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ params: { missingProperty: "3" } }),
        ]),
      )

      // ...and a complete override still validates.
      const complete = {
        withdrawal: { level: { 0: 12500, 1: 100000, 2: 5000000, 3: 5000000 } },
        intraLedger: { level: { 0: 12500, 1: 100000, 2: 5000000, 3: 5000000 } },
        tradeIntraAccount: { level: { 0: 200000, 1: 5000000, 2: 20000000, 3: 20000000 } },
      }
      expect(validate({ accountLimits: complete })).toBe(true)
    })
  })

  // The operator switch in front of the guard (src/app/payments/authorize-send.ts).
  // Its failure mode must be "the guard does not block", never "every send is
  // refused", so every path back from a missing or malformed value lands on
  // log-only.
  describe("sendGuard.mode", () => {
    const compileSendGuard = () =>
      new Ajv({ useDefaults: true }).compile({
        type: "object",
        properties: { sendGuard: configSchema.properties.sendGuard },
      })

    it("ships as log-only so the first Flash-side amount cap does not go straight to enforcing", () => {
      expect(getSendGuardMode()).toBe("log-only")
    })

    it("defaults the whole block when a deployment yaml has no sendGuard key", () => {
      const config: Record<string, unknown> = {}
      expect(compileSendGuard()(config)).toBe(true)
      expect(config.sendGuard).toEqual({ mode: "log-only" })
    })

    it("defaults `mode` when a deployment sets sendGuard but not mode", () => {
      const config: Record<string, unknown> = { sendGuard: {} }
      expect(compileSendGuard()(config)).toBe(true)
      expect(config.sendGuard).toEqual({ mode: "log-only" })
    })

    it("rejects a mode outside the three known values at boot", () => {
      expect(compileSendGuard()({ sendGuard: { mode: "enforced" } })).toBe(false)
    })

    it.each(["off", "log-only", "enforce"])("accepts %p", (mode) => {
      expect(compileSendGuard()({ sendGuard: { mode } })).toBe(true)
    })
  })

  describe("payment-send attempt budgets", () => {
    it("bounds a burst at 10 attempts/minute", () => {
      expect(getPaymentSendAttemptLimits()).toEqual({
        points: 10,
        duration: 60,
        blockDuration: 60,
      })
    })

    it("bounds a day at 200 attempts", () => {
      expect(getPaymentSendDailyAttemptLimits()).toEqual({
        points: 200,
        duration: 86400,
        blockDuration: 86400,
      })
    })

    // The claim in the name above is a behavioural one, and the numbers alone
    // do not make it true. rate-limiter-flexible rewrites the key's TTL to
    // `blockDuration` on the first breach (RateLimiterStoreAbstract._afterConsume
    // -> _block), so a block SHORTER than the window throws the daily counter
    // away early and hands the caller a fresh `points` budget: 200 points over
    // 86400s blocked for only 3600s is 200 per HOUR, ~4,800 attempts a day.
    it("keeps the daily counter alive for the whole window after a breach", async () => {
      const { duration, blockDuration } = getPaymentSendDailyAttemptLimits()
      const limiter = new RateLimiterMemory({ points: 1, duration, blockDuration })

      await limiter.consume("account-id")
      const breach = await limiter
        .consume("account-id")
        .then(() => null)
        .catch((err) => err)

      expect(breach).toBeInstanceOf(RateLimiterRes)
      // Within a second of a full day, not an hour.
      expect(breach.msBeforeNext).toBeGreaterThan(duration * 1000 - 1000)
    })

    it("is wired into RateLimitConfig with its own prefixes and error", () => {
      expect(RateLimitConfig.paymentSend).toEqual({
        key: RateLimitPrefix.paymentSend,
        limits: getPaymentSendAttemptLimits(),
        error: PaymentSendRateLimiterExceededError,
      })
      expect(RateLimitConfig.paymentSendDaily).toEqual({
        key: RateLimitPrefix.paymentSendDaily,
        limits: getPaymentSendDailyAttemptLimits(),
        error: PaymentSendRateLimiterExceededError,
      })
      expect(RateLimitPrefix.paymentSend).not.toBe(RateLimitPrefix.paymentSendDaily)
    })

    // Prod overrides the whole `rateLimits` block (deployments
    // flash-values.tmpl.yaml) without these keys. A `required` entry would fail
    // validation at boot; a property default fills the gap instead.
    it("defaults the new buckets even when a deployment overrides rateLimits without them", () => {
      // Wrap the rateLimits sub-schema so `default` sits below the root (Ajv
      // strict mode ignores root-level defaults); the full config schema would
      // require every other top-level key too.
      const validate = new Ajv({ useDefaults: true }).compile({
        type: "object",
        properties: { rateLimits: configSchema.properties.rateLimits },
        required: ["rateLimits"],
      })
      const legacyBucket = { points: 1, duration: 1, blockDuration: 1 }
      const rateLimits: Record<string, unknown> = {
        requestCodePerLoginIdentifier: legacyBucket,
        requestCodePerIp: legacyBucket,
        failedLoginAttemptPerLoginIdentifier: legacyBucket,
        failedLoginAttemptPerIp: legacyBucket,
        invoiceCreateAttempt: legacyBucket,
        invoiceCreateForRecipientAttempt: legacyBucket,
        onChainAddressCreateAttempt: legacyBucket,
      }
      const wrapped = { rateLimits }
      expect(validate(wrapped) ? null : validate.errors).toBeNull()
      expect(rateLimits.paymentSendAttempt).toEqual({
        points: 10,
        duration: 60,
        blockDuration: 60,
      })
      expect(rateLimits.paymentSendDailyAttempt).toEqual({
        points: 200,
        duration: 86400,
        blockDuration: 86400,
      })
    })
  })
})
