import Ajv from "ajv"

import { RateLimitConfig } from "@domain/rate-limit"

import { configSchema } from "../../../../src/config/schema"

// Prod overrides the whole `rateLimits` block without the POS keys, so they
// must come from property defaults, not `required` entries.
it("defaults the POS on-chain buckets when a deployment overrides rateLimits without them", () => {
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
  expect(validate({ rateLimits }) ? null : validate.errors).toBeNull()
  expect(rateLimits).toMatchObject({
    posOnChainAddressCreateAttempt: { points: 60, duration: 3600, blockDuration: 0 },
    posOnChainAddressCreatePerIpAttempt: { points: 10, duration: 3600, blockDuration: 0 },
    posOnChainSupportedPerIp: { points: 60, duration: 60, blockDuration: 0 },
    posOnChainCreatePerIp: { points: 60, duration: 60, blockDuration: 0 },
    posOnChainStatusPerIp: { points: 240, duration: 60, blockDuration: 0 },
  })
})

it("never blocks a merchant's POS allocation bucket, and keeps it apart from the app's", () => {
  expect(RateLimitConfig.posOnChainAddressCreate.limits).toEqual({
    points: 60,
    duration: 3600,
    blockDuration: 0,
  })
  expect(RateLimitConfig.posOnChainAddressCreatePerIp.limits).toEqual({
    points: 10,
    duration: 3600,
    blockDuration: 0,
  })
  const keys = Object.values(RateLimitConfig).map((c) => c.key)
  expect(new Set(keys).size).toBe(keys.length)
})
