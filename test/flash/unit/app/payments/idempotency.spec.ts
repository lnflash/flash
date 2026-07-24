// Unit tests for the ENG-530 payment-send idempotency helper in isolation.
// The wrapped-send integration behavior (Ibex call counts, ops events) is covered
// in send-intraledger.spec.ts; here we exercise the helper's own logic against
// in-memory cache + lock mocks.
//
// The cache mock stores JSON strings and parses them back on read, so these tests
// exercise the REAL serialization round-trip a Redis-backed store performs — a
// replayed { value: "success" } is a freshly-deserialized object, not the original
// reference.

const mockCacheStore = new Map<string, string>()
let mockLockHeld = false
let mockCacheSetShouldFail = false

jest.mock("@services/cache", () => ({
  RedisCacheService: () => ({
    get: async ({ key }: { key: string }) =>
      mockCacheStore.has(key)
        ? JSON.parse(mockCacheStore.get(key) as string)
        : new Error("cache miss"),
    set: async ({ key, value }: { key: string; value: unknown }) => {
      if (mockCacheSetShouldFail) return new Error("cache set failed")
      mockCacheStore.set(key, JSON.stringify(value))
      return value
    },
  }),
}))

jest.mock("@services/lock", () => {
  const { ResourceAttemptsLockServiceError } = jest.requireActual("@domain/lock")
  return {
    LockService: () => ({
      // Models redlock `.using`: if the key is already held, fail (busy) without
      // running the callback; otherwise run it under the lock and release after.
      lockPaymentIdempotencyKey: async (
        _key: string,
        asyncFn: (signal: unknown) => Promise<unknown>,
      ) => {
        if (mockLockHeld) return new ResourceAttemptsLockServiceError()
        return asyncFn({ aborted: false })
      },
    }),
  }
})

jest.mock("@services/tracing", () => ({
  recordExceptionInCurrentSpan: jest.fn(),
  addAttributesToCurrentSpan: jest.fn(),
}))

import { withPaymentIdempotency } from "@app/payments/idempotency"
import { PaymentSendStatus } from "@domain/bitcoin/lightning"
import {
  IdempotencyKeyReuseError,
  InvalidIdempotencyKeyError,
  MismatchedCurrencyForWalletError,
} from "@domain/errors"
import { ResourceAttemptsLockServiceError } from "@domain/lock"
import { recordExceptionInCurrentSpan } from "@services/tracing"

const walletA = "11111111-1111-4111-8111-111111111111" as WalletId
const walletB = "22222222-2222-4222-8222-222222222222" as WalletId
const fingerprint = "recipient-1|100"

describe("withPaymentIdempotency", () => {
  beforeEach(() => {
    mockCacheStore.clear()
    mockLockHeld = false
    mockCacheSetShouldFail = false
    ;(recordExceptionInCurrentSpan as jest.Mock).mockClear()
  })

  it("runs execute unchanged when no key is supplied", async () => {
    const execute = jest.fn().mockResolvedValue(PaymentSendStatus.Success)

    const result = await withPaymentIdempotency({
      idempotencyKey: undefined,
      senderWalletId: walletA,
      requestFingerprint: fingerprint,
      execute,
    })

    expect(result).toBe(PaymentSendStatus.Success)
    expect(execute).toHaveBeenCalledTimes(1)
    // No key => nothing persisted.
    expect(mockCacheStore.size).toBe(0)
  })

  it("treats a blank/whitespace key as no key (executes normally)", async () => {
    const execute = jest.fn().mockResolvedValue(PaymentSendStatus.Success)

    const result = await withPaymentIdempotency({
      idempotencyKey: "   ",
      senderWalletId: walletA,
      requestFingerprint: fingerprint,
      execute,
    })

    expect(result).toBe(PaymentSendStatus.Success)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(mockCacheStore.size).toBe(0)
  })

  it("rejects an oversized key without executing", async () => {
    const execute = jest.fn().mockResolvedValue(PaymentSendStatus.Success)

    const result = await withPaymentIdempotency({
      idempotencyKey: "x".repeat(257),
      senderWalletId: walletA,
      requestFingerprint: fingerprint,
      execute,
    })

    expect(result).toBeInstanceOf(InvalidIdempotencyKeyError)
    expect(execute).not.toHaveBeenCalled()
  })

  it("executes once for a key, then replays the cached result", async () => {
    const execute = jest.fn().mockResolvedValue(PaymentSendStatus.Success)

    const first = await withPaymentIdempotency({
      idempotencyKey: "key-1",
      senderWalletId: walletA,
      requestFingerprint: fingerprint,
      execute,
    })
    const second = await withPaymentIdempotency({
      idempotencyKey: "key-1",
      senderWalletId: walletA,
      requestFingerprint: fingerprint,
      execute,
    })

    expect(first).toEqual(PaymentSendStatus.Success)
    expect(second).toEqual(PaymentSendStatus.Success)
    // Second call is served from cache — execute runs exactly once.
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it("replays a JSON round-tripped result (proves real serialization, not a reference)", async () => {
    const execute = jest.fn().mockResolvedValue(PaymentSendStatus.Success)

    await withPaymentIdempotency({
      idempotencyKey: "key-1",
      senderWalletId: walletA,
      requestFingerprint: fingerprint,
      execute,
    })
    const replay = await withPaymentIdempotency({
      idempotencyKey: "key-1",
      senderWalletId: walletA,
      requestFingerprint: fingerprint,
      execute,
    })

    // Deep-equal to the enum value...
    expect(replay).toEqual({ value: "success" })
    // ...but a distinct object — it was serialized to Redis and parsed back.
    expect(replay).not.toBe(PaymentSendStatus.Success)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it("rejects a key reused for a different payment (fingerprint mismatch) without executing again", async () => {
    const execute = jest.fn().mockResolvedValue(PaymentSendStatus.Success)

    const first = await withPaymentIdempotency({
      idempotencyKey: "shared-key",
      senderWalletId: walletA,
      requestFingerprint: "pay-to-alice|100",
      execute,
    })
    const second = await withPaymentIdempotency({
      idempotencyKey: "shared-key",
      senderWalletId: walletA,
      requestFingerprint: "pay-to-bob|100",
      execute,
    })

    expect(first).toEqual(PaymentSendStatus.Success)
    // Same key, different payment => conflict, not a silent replay of the first.
    expect(second).toBeInstanceOf(IdempotencyKeyReuseError)
    // And the conflicting request did NOT execute.
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it("returns the busy lock error and does not execute when the key is in flight", async () => {
    mockLockHeld = true
    const execute = jest.fn().mockResolvedValue(PaymentSendStatus.Success)

    const result = await withPaymentIdempotency({
      idempotencyKey: "key-1",
      senderWalletId: walletA,
      requestFingerprint: fingerprint,
      execute,
    })

    expect(result).toBeInstanceOf(ResourceAttemptsLockServiceError)
    expect(execute).not.toHaveBeenCalled()
  })

  it("does not cache an error result — a fresh attempt re-executes", async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce(new MismatchedCurrencyForWalletError())
      .mockResolvedValueOnce(PaymentSendStatus.Success)

    const first = await withPaymentIdempotency({
      idempotencyKey: "key-1",
      senderWalletId: walletA,
      requestFingerprint: fingerprint,
      execute,
    })
    const second = await withPaymentIdempotency({
      idempotencyKey: "key-1",
      senderWalletId: walletA,
      requestFingerprint: fingerprint,
      execute,
    })

    expect(first).toBeInstanceOf(MismatchedCurrencyForWalletError)
    expect(second).toEqual(PaymentSendStatus.Success)
    // The error return was not cached, so the second attempt executed again.
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it("records a critical exception when cache.set fails after a completed send", async () => {
    mockCacheSetShouldFail = true
    const execute = jest.fn().mockResolvedValue(PaymentSendStatus.Success)

    const result = await withPaymentIdempotency({
      idempotencyKey: "key-1",
      senderWalletId: walletA,
      requestFingerprint: fingerprint,
      execute,
    })

    // The payment already executed — we still return its outcome...
    expect(result).toEqual(PaymentSendStatus.Success)
    expect(execute).toHaveBeenCalledTimes(1)
    // ...but the failed persist is surfaced loudly (money moved, result not stored).
    expect(recordExceptionInCurrentSpan).toHaveBeenCalledTimes(1)
    expect(recordExceptionInCurrentSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        fallbackMsg: expect.stringContaining("double-pay"),
        attributes: expect.objectContaining({
          "idempotency.scopedKey": `${walletA}:key-1`,
        }),
      }),
    )
  })

  it("scopes the key per sender wallet — the same key from a different wallet does not collide", async () => {
    const execute = jest.fn().mockResolvedValue(PaymentSendStatus.Success)

    await withPaymentIdempotency({
      idempotencyKey: "shared-key",
      senderWalletId: walletA,
      requestFingerprint: fingerprint,
      execute,
    })
    await withPaymentIdempotency({
      idempotencyKey: "shared-key",
      senderWalletId: walletB,
      requestFingerprint: fingerprint,
      execute,
    })

    // Different wallet scope => distinct cache entries => both execute.
    expect(execute).toHaveBeenCalledTimes(2)
    expect(mockCacheStore.size).toBe(2)
  })
})
