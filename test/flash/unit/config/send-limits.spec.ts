import Ajv from "ajv"

import {
  getAccountLimits,
  getPaymentSendAttemptLimits,
  getPaymentSendDailyAttemptLimits,
} from "@config"

import { AccountLevel } from "@domain/accounts"
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

    it("keeps the Galoy defaults for levels 0-2", () => {
      expect(getAccountLimits({ level: AccountLevel.Zero })).toEqual({
        intraLedgerLimit: 12500,
        withdrawalLimit: 12500,
        tradeIntraAccountLimit: 200000,
      })
      expect(getAccountLimits({ level: AccountLevel.One })).toEqual({
        intraLedgerLimit: 200000,
        withdrawalLimit: 100000,
        tradeIntraAccountLimit: 5000000,
      })
      expect(getAccountLimits({ level: AccountLevel.Two })).toEqual({
        intraLedgerLimit: 5000000,
        withdrawalLimit: 5000000,
        tradeIntraAccountLimit: 20000000,
      })
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
        blockDuration: 3600,
      })
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
        blockDuration: 3600,
      })
    })
  })
})
