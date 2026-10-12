const mockSend = jest.fn()
const mockAuthorizeSend = jest.fn()
const mockNotify = jest.fn()
const mockFindWalletById = jest.fn()
const mockFindAccountById = jest.fn()
const mockIsInternal = jest.fn()
const mockNotifyOps = jest.fn()

jest.mock("@app/payments/send-intraledger", () => ({
  intraledgerPaymentSendWalletIdForUsdWallet: (...args: unknown[]) => mockSend(...args),
}))

jest.mock("@app/payments/authorize-send", () => ({
  authorizeSend: (...args: unknown[]) => mockAuthorizeSend(...args),
}))

jest.mock("@app/notifications/send-outcome-notification", () => ({
  sendOutcomeNotificationBestEffort: (...args: unknown[]) => mockNotify(...args),
}))

jest.mock("@services/mongoose", () => ({
  WalletsRepository: jest.fn(() => ({
    findById: (...args: unknown[]) => mockFindWalletById(...args),
  })),
  AccountsRepository: jest.fn(() => ({
    findById: (...args: unknown[]) => mockFindAccountById(...args),
  })),
}))

jest.mock("@services/mongoose/internal-transfer-invoices", () => ({
  isInternalTransferInvoice: (...args: unknown[]) => mockIsInternal(...args),
}))

jest.mock("@services/alerts/ops-events", () => ({
  notifyOpsEvent: (...args: unknown[]) => mockNotifyOps(...args),
}))

jest.mock("@services/mongoose/payment-split-executions", () => ({
  PaymentSplitExecutionsRepository: jest.fn(() => mockStore.repo),
}))

import { PaymentSplitsConfig } from "@config"
import {
  executePendingSplits,
  splitIdempotencyKey,
} from "@app/payment-splits/execute-pending-splits"
import { PaymentSendStatus } from "@domain/bitcoin/lightning"
import {
  InactiveAccountError,
  IntraledgerLimitsExceededError,
  RepositoryError,
} from "@domain/errors"
import {
  ResourceAttemptsLockServiceError,
  ResourceExpiredLockServiceError,
  UnknownLockServiceError,
} from "@domain/lock"
import { InternalTransferMarkerError, splitRetryBackoffMs } from "@domain/payment-splits"
import { SendLimitsUnavailableError } from "@domain/payments/errors"
import { PaymentSendRateLimiterExceededError } from "@domain/rate-limit/errors"
import { WalletCurrency } from "@domain/shared"
import { InsufficientIbexBalance } from "@services/ibex/errors"

import { createFakeExecutionsStore } from "./fake-executions-store"

// Read lazily by the repository mock above, so defining it after the imports
// is safe: the mock factory only captures the reference.
const mockStore = createFakeExecutionsStore()

const SOURCE = "source-wallet"
const DEST = "dest-wallet"
const OWNER = { id: "owner-account", level: 1 }
const T0 = new Date("2026-10-11T12:00:00Z")
const minutes = (m: number) => new Date(T0.getTime() + m * 60_000)

const seed = async (shareCents = 250): Promise<{ id: string }> => {
  const inserted = await mockStore.repo.insert({
    triggerKey: "a".repeat(64),
    ruleId: "rule-1",
    walletId: SOURCE,
    destinationWalletId: DEST,
    currency: WalletCurrency.Usdt,
    triggerAmountMinor: "10000000",
    shareCents,
    status: "pending",
    now: T0,
  })
  if (!inserted.inserted) throw new Error("seed collided")
  return { id: inserted.id }
}

const onlyRow = () => [...mockStore.rows.values()][0]

const original = { ...PaymentSplitsConfig }

beforeEach(() => {
  jest.clearAllMocks()
  mockStore.rows.clear()
  Object.assign(PaymentSplitsConfig, {
    enabled: true,
    maxAttempts: 5,
    executorTimeBudgetMs: 45_000,
  })
  mockIsInternal.mockResolvedValue(false)
  mockFindWalletById.mockResolvedValue({
    id: SOURCE,
    accountId: OWNER.id,
    currency: WalletCurrency.Usdt,
  })
  mockFindAccountById.mockResolvedValue(OWNER)
  mockAuthorizeSend.mockResolvedValue(true)
  mockNotify.mockResolvedValue(undefined)
})

afterAll(() => {
  Object.assign(PaymentSplitsConfig, original)
})

describe("executePendingSplits", () => {
  it("pays the share from the receiving wallet through the guarded intraledger send", async () => {
    const { id } = await seed(250)
    mockSend.mockResolvedValue(PaymentSendStatus.Success)

    const summary = await executePendingSplits({ now: T0 })

    expect(summary).toEqual({
      claimed: 1,
      sent: 1,
      ibexPending: 0,
      failed: 0,
      retried: 0,
      unknown: 0,
      skippedInternal: 0,
    })
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        senderWalletId: SOURCE,
        recipientWalletId: DEST,
        amount: 250,
        memo: "Payment split",
        senderAccount: OWNER,
        idempotencyKey: `split:${id}`,
      }),
    )

    // The authorize hook is the ENG-573 guard for an intraledger send.
    await mockSend.mock.calls[0][0].authorize()
    expect(mockAuthorizeSend).toHaveBeenCalledWith({
      senderAccount: OWNER,
      senderWalletId: SOURCE,
      amount: { currency: "USD", cents: 250 },
      kind: "intraledger",
    })

    expect(onlyRow()).toMatchObject({ status: "sent", attempts: 1 })
    expect(mockNotify).toHaveBeenCalledTimes(1)
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: OWNER.id,
        phraseBase: "notification.paymentSplit.sent",
        amountArg: "US$2.50",
      }),
    )
  })

  it("marks an IBEX pending send ibex_pending and never retries it", async () => {
    await seed()
    mockSend.mockResolvedValue(PaymentSendStatus.Pending)

    await executePendingSplits({ now: T0 })
    expect(onlyRow()).toMatchObject({ status: "ibex_pending", attempts: 1 })

    await executePendingSplits({ now: minutes(60) })
    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(mockNotify).not.toHaveBeenCalled()
  })

  it.each([
    ["an ENG-573 limit rejection", new IntraledgerLimitsExceededError("over limit")],
    ["insufficient balance", new InsufficientIbexBalance(new Error("insufficient"))],
    ["an inactive account", new InactiveAccountError()],
  ])("fails on the first attempt with %s and pushes the owner", async (_label, error) => {
    await seed()
    mockSend.mockResolvedValue(error)

    const summary = await executePendingSplits({ now: T0 })

    expect(summary).toMatchObject({ claimed: 1, failed: 1, retried: 0 })
    expect(onlyRow()).toMatchObject({
      status: "failed",
      attempts: 1,
      lastError: error.name,
    })
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: OWNER.id,
        phraseBase: "notification.paymentSplit.failed",
      }),
    )
  })

  it("fails an IBEX Failure status and pushes the owner", async () => {
    await seed()
    mockSend.mockResolvedValue(PaymentSendStatus.Failure)

    await executePendingSplits({ now: T0 })

    expect(onlyRow()).toMatchObject({ status: "failed" })
    expect(mockNotify).toHaveBeenCalledTimes(1)
  })

  it("retries a retryable error with 1/2/4/8 minute backoff, then fails at the attempt budget", async () => {
    await seed()
    mockSend.mockResolvedValue(new PaymentSendRateLimiterExceededError())

    let now = T0
    const expectedBackoffs = [1, 2, 4, 8]
    for (const [i, backoff] of expectedBackoffs.entries()) {
      await executePendingSplits({ now })
      expect(onlyRow()).toMatchObject({ status: "pending", attempts: i + 1 })
      const next = new Date(now.getTime() + backoff * 60_000)
      expect(onlyRow().nextAttemptAt).toEqual(next)

      // Not due yet: nothing is claimed a second early.
      await executePendingSplits({ now: new Date(next.getTime() - 1000) })
      expect(mockSend).toHaveBeenCalledTimes(i + 1)
      now = next
    }

    await executePendingSplits({ now })
    expect(mockSend).toHaveBeenCalledTimes(5)
    expect(onlyRow()).toMatchObject({ status: "failed", attempts: 5 })
    expect(mockNotify).toHaveBeenCalledTimes(1)
  })

  it("runs every minute in production, so the 1-minute backoff step is real", () => {
    expect(PaymentSplitsConfig.loopIntervalMs).toBeLessThanOrEqual(splitRetryBackoffMs(1))
  })

  it.each([
    ["send guard unavailable", new SendLimitsUnavailableError("redis")],
    ["marker write failure", new InternalTransferMarkerError("mongo")],
    ["a busy idempotency lock", new ResourceAttemptsLockServiceError()],
  ])("treats %s as retryable", async (_label, error) => {
    await seed()
    mockSend.mockResolvedValue(error)

    await executePendingSplits({ now: T0 })

    expect(onlyRow()).toMatchObject({ status: "pending", attempts: 1 })
    expect(mockNotify).not.toHaveBeenCalled()
  })

  it("uses the same idempotency key on every retry of one execution", async () => {
    const { id } = await seed()
    mockSend
      .mockResolvedValueOnce(new PaymentSendRateLimiterExceededError())
      .mockResolvedValueOnce(PaymentSendStatus.Success)

    await executePendingSplits({ now: T0 })
    await executePendingSplits({ now: minutes(1) })

    const keys = mockSend.mock.calls.map((call) => call[0].idempotencyKey)
    expect(keys).toEqual([splitIdempotencyKey(id), splitIdempotencyKey(id)])
    expect(onlyRow()).toMatchObject({ status: "sent", attempts: 2 })
  })

  it("lets only one of two concurrent executors claim a row", async () => {
    await seed()
    let release: (v: unknown) => void = () => undefined
    const sendReached = new Promise<void>((reached) => {
      mockSend.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve
            reached()
          }),
      )
    })

    const first = executePendingSplits({ now: T0 })
    const second = executePendingSplits({ now: T0 })
    const secondSummary = await second
    await sendReached
    release(PaymentSendStatus.Success)
    const firstSummary = await first

    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(
      [firstSummary, secondSummary].map((s) => (s instanceof Error ? -1 : s.claimed)),
    ).toEqual([1, 0])
  })

  const seedMany = async (count: number) => {
    for (let i = 0; i < count; i++) {
      await mockStore.repo.insert({
        triggerKey: `${i}`.padStart(64, "c"),
        ruleId: "rule-1",
        walletId: SOURCE,
        destinationWalletId: DEST,
        currency: WalletCurrency.Usdt,
        triggerAmountMinor: "1000000",
        shareCents: 10,
        status: "pending",
        now: T0,
      })
    }
  }

  it("drains every due row in one pass, with no fixed batch cap", async () => {
    await seedMany(120)
    mockSend.mockResolvedValue(PaymentSendStatus.Success)

    expect(await executePendingSplits({ now: T0 })).toMatchObject({
      claimed: 120,
      sent: 120,
    })
    expect([...mockStore.rows.values()].every((r) => r.status === "sent")).toBe(true)
  })

  it("stops claiming once the time budget is spent", async () => {
    PaymentSplitsConfig.executorTimeBudgetMs = 1000
    await seedMany(3)
    mockSend.mockResolvedValue(PaymentSendStatus.Success)
    // Each clock read advances 600ms: the deadline is set at 600 + 1000, the
    // first check (1200) claims one row, the second (1800) is past it.
    let t = 0
    const clock = () => (t += 600)

    expect(await executePendingSplits({ now: T0, clock })).toMatchObject({ claimed: 1 })
    expect(await executePendingSplits({ now: T0 })).toMatchObject({ claimed: 2 })
  })

  describe("lock errors", () => {
    // The send reached the payment: the authorize hook (which runs
    // immediately before Ibex.payInvoice) passed, then the lock layer erred.
    const afterAuthorize =
      (error: Error) =>
      async (args: { authorize: () => Promise<unknown> }): Promise<Error> => {
        await args.authorize()
        return error
      }

    it.each([
      [
        "UnknownLockServiceError (routine threw / release failed)",
        new UnknownLockServiceError("release"),
      ],
      ["ResourceExpiredLockServiceError", new ResourceExpiredLockServiceError("expired")],
      [
        "ResourceAttemptsLockServiceError from the release",
        new ResourceAttemptsLockServiceError(),
      ],
    ])(
      "never retries %s after the payment was reached; marks unknown and alerts ops",
      async (_label, error) => {
        await seed()
        mockSend.mockImplementation(afterAuthorize(error))

        const summary = await executePendingSplits({ now: T0 })

        expect(summary).toMatchObject({ claimed: 1, unknown: 1, retried: 0, failed: 0 })
        expect(onlyRow()).toMatchObject({ status: "unknown", attempts: 1 })
        expect(mockNotifyOps).toHaveBeenCalledWith(
          expect.objectContaining({ phase: "split-unknown", status: "failed" }),
        )

        // Never re-sent, however long the executor keeps running.
        await executePendingSplits({ now: minutes(60) })
        expect(mockSend).toHaveBeenCalledTimes(1)
      },
    )

    it.each([
      ["UnknownLockServiceError", new UnknownLockServiceError("boom")],
      ["ResourceExpiredLockServiceError", new ResourceExpiredLockServiceError("expired")],
    ])("never retries %s even before the payment was reached", async (_label, error) => {
      await seed()
      mockSend.mockResolvedValue(error)

      await executePendingSplits({ now: T0 })

      expect(onlyRow()).toMatchObject({ status: "unknown" })
      await executePendingSplits({ now: minutes(60) })
      expect(mockSend).toHaveBeenCalledTimes(1)
    })
  })

  describe("internal-transfer re-check", () => {
    it("skips a row whose hash was marked internal after it was recorded", async () => {
      await seed()
      mockIsInternal.mockResolvedValue(true)

      const summary = await executePendingSplits({ now: T0 })

      expect(summary).toMatchObject({ claimed: 1, skippedInternal: 1 })
      expect(mockIsInternal).toHaveBeenCalledWith("a".repeat(64))
      expect(onlyRow()).toMatchObject({ status: "skipped_internal" })
      expect(mockSend).not.toHaveBeenCalled()
      expect(mockNotify).not.toHaveBeenCalled()
    })

    it("retries when the marker cannot be read, without sending", async () => {
      await seed()
      mockIsInternal.mockResolvedValue(new RepositoryError("mongo"))

      await executePendingSplits({ now: T0 })

      expect(onlyRow()).toMatchObject({ status: "pending", attempts: 1 })
      expect(mockSend).not.toHaveBeenCalled()
    })
  })

  it("never sends a skipped_min row", async () => {
    await mockStore.repo.insert({
      triggerKey: "b".repeat(64),
      ruleId: "rule-1",
      walletId: SOURCE,
      destinationWalletId: DEST,
      currency: WalletCurrency.Usd,
      triggerAmountMinor: "3",
      shareCents: 0,
      status: "skipped_min",
      now: T0,
    })

    expect(await executePendingSplits({ now: T0 })).toMatchObject({ claimed: 0 })
    expect(mockSend).not.toHaveBeenCalled()
  })

  it("does nothing while the feature flag is off", async () => {
    await seed()
    PaymentSplitsConfig.enabled = false

    expect(await executePendingSplits({ now: T0 })).toMatchObject({ claimed: 0 })
    expect(onlyRow()).toMatchObject({ status: "pending" })
    expect(mockSend).not.toHaveBeenCalled()
  })
})
