const mockPayLeg = jest.fn()
const mockNotify = jest.fn()
const mockFindWalletById = jest.fn()
const mockFindAccountById = jest.fn()
const mockIsInternal = jest.fn()
const mockNotifyOps = jest.fn()
const mockDisableRule = jest.fn()
const mockRuleExists = jest.fn()
jest.mock("@services/logger", () => {
  const logger = {
    trace: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fatal: jest.fn(),
  }
  return { baseLogger: { ...logger, child: () => logger } }
})

jest.mock("@app/payment-splits/internal-transfer", () => ({
  paySplitLeg: (...args: unknown[]) => mockPayLeg(...args),
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

jest.mock("@services/mongoose/payment-split-rules", () => ({
  PaymentSplitRulesRepository: jest.fn(() => ({
    disableForDestination: (...args: unknown[]) => mockDisableRule(...args),
    existsForDestination: (...args: unknown[]) => mockRuleExists(...args),
  })),
}))

jest.mock("@services/mongoose/payment-split-executions", () => ({
  PaymentSplitExecutionsRepository: jest.fn(() => mockStore.repo),
}))

import { PaymentSplitsConfig } from "@config"
import {
  executePendingSplits,
  isAmbiguousSplitSendError,
  isRetryableSplitError,
  PAYMENT_SPLIT_MEMO,
} from "@app/payment-splits/execute-pending-splits"
import { PaymentSendStatus } from "@domain/bitcoin/lightning"
import {
  CouldNotFindAccountFromIdError,
  CouldNotFindWalletFromIdError,
  InactiveAccountError,
  RepositoryError,
  UnknownRepositoryError,
} from "@domain/errors"
import { InternalTransferMarkerError, splitRetryBackoffMs } from "@domain/payment-splits"
import { WalletCurrency } from "@domain/shared"
import { IbexError, UnexpectedIbexResponse } from "@services/ibex/errors"

import { createFakeExecutionsStore } from "./fake-executions-store"

// Read lazily by the repository mock above, so defining it after the imports
// is safe: the mock factory only captures the reference.
const mockStore = createFakeExecutionsStore()

const mockLogger = (
  jest.requireMock("@services/logger") as { baseLogger: { error: jest.Mock } }
).baseLogger

const SHADOW = "shadow-ibex-account"
const SOURCE = "source-wallet"
const DEST = "dest-wallet"
const OWNER = { id: "owner-account", level: 1, status: "active" }
const DEST_ACCOUNT = "dest-account"
const T0 = new Date("2026-10-19T12:00:00Z")
const minutes = (m: number) => new Date(T0.getTime() + m * 60_000)

const seed = async ({
  shareCents = 250,
  triggerKey = "a".repeat(64),
  legKind = "share",
  destinationWalletId = DEST,
  grossMinor = "10000000",
} = {}): Promise<{ id: string }> => {
  const inserted = await mockStore.repo.insert({
    triggerKey,
    legKind,
    ruleId: legKind === "net" ? SOURCE : "rule-1",
    walletId: SOURCE,
    sourceIbexAccountId: SHADOW,
    destinationWalletId,
    currency: WalletCurrency.Usdt,
    grossMinor,
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
  mockNotify.mockResolvedValue(undefined)
  mockDisableRule.mockResolvedValue(true)
  mockRuleExists.mockResolvedValue(true)
})

afterAll(() => {
  Object.assign(PaymentSplitsConfig, original)
})

describe("executePendingSplits", () => {
  it("pays a share leg from the shadow receive account to the destination", async () => {
    await seed({ shareCents: 250 })
    mockPayLeg.mockResolvedValue(PaymentSendStatus.Success)

    const summary = await executePendingSplits({ now: T0 })

    expect(summary).toEqual({
      claimed: 1,
      sent: 1,
      ibexPending: 0,
      failed: 0,
      folded: 0,
      retried: 0,
      unknown: 0,
    })
    expect(mockPayLeg).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceIbexAccountId: SHADOW,
        destinationWalletId: DEST,
        cents: 250,
        currency: WalletCurrency.Usdt,
        memo: PAYMENT_SPLIT_MEMO,
      }),
    )

    expect(onlyRow()).toMatchObject({ status: "sent", attempts: 1 })
    // No "split sent" push in v2: the merchant's settle push named the split,
    // and destinations get their ordinary receive push (ENG-717 §2.6).
    expect(mockNotify).not.toHaveBeenCalled()
  })

  it("carries the gross in the net leg's memo (history = net + memo, decision 3)", async () => {
    await seed({ legKind: "net", destinationWalletId: SOURCE, grossMinor: "5000000" })
    mockPayLeg.mockResolvedValue(PaymentSendStatus.Success)

    await executePendingSplits({ now: T0 })

    expect(mockPayLeg).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceIbexAccountId: SHADOW,
        destinationWalletId: SOURCE,
        memo: expect.stringContaining("$5.00"),
      }),
    )
  })

  it("marks an IBEX pending send ibex_pending and never retries it", async () => {
    await seed()
    mockPayLeg.mockResolvedValue(PaymentSendStatus.Pending)

    await executePendingSplits({ now: T0 })
    expect(onlyRow()).toMatchObject({ status: "ibex_pending", attempts: 1 })

    await executePendingSplits({ now: minutes(60) })
    expect(mockPayLeg).toHaveBeenCalledTimes(1)
    expect(mockNotify).not.toHaveBeenCalled()
  })

  it.each([
    [
      "insufficient balance on the shadow",
      Object.assign(new IbexError(new Error("insufficient")), { httpCode: 400 }),
    ],
    ["an inactive destination account", new InactiveAccountError(DEST_ACCOUNT)],
  ])(
    "fails terminally on %s, folds the share to the merchant, pushes the owner",
    async (_label, error) => {
      await seed()
      mockPayLeg.mockResolvedValue(error)

      const summary = await executePendingSplits({ now: T0 })

      expect(summary).toMatchObject({ claimed: 1, folded: 1, retried: 0 })
      expect(onlyRow()).toMatchObject({
        status: "failed",
        attempts: 1,
        lastError: error.name,
      })
      // The fold row: a share-kind row to the MERCHANT, claimable now.
      const fold = [...mockStore.rows.values()].find(
        (r) => r.legKind === "share" && r.destinationWalletId === SOURCE,
      )
      expect(fold).toBeDefined()
      expect(fold).toMatchObject({
        status: "pending",
        shareCents: 250,
        sourceIbexAccountId: SHADOW,
      })
      expect(mockNotify).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: OWNER.id,
          phraseBase: "notification.paymentSplit.failed",
          amountArg: "US$2.50",
        }),
      )
    },
  )

  it("does not fold or push for a net leg failure — the money stays pending in the shadow (only human-resolution case)", async () => {
    await seed({ legKind: "net", destinationWalletId: SOURCE })
    mockPayLeg.mockResolvedValue(new InactiveAccountError(OWNER.id))

    const summary = await executePendingSplits({ now: T0 })

    expect(summary).toMatchObject({ claimed: 1, failed: 1 })
    expect(onlyRow()).toMatchObject({ status: "failed" })
    // No fold row: the net leg IS the merchant's money.
    const fold = [...mockStore.rows.values()].find(
      (r) => r.legKind === "share" && r.destinationWalletId === SOURCE,
    )
    expect(fold).toBeUndefined()
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ phraseBase: "notification.paymentSplit.failed" }),
    )
    expect(mockNotifyOps).not.toHaveBeenCalled()
  })

  describe("inactive destination account (ENG-660 carry-over)", () => {
    const destinationStatus = (status: string) => {
      mockFindWalletById.mockImplementation(async (id: string) =>
        id === DEST
          ? { id: DEST, accountId: DEST_ACCOUNT, currency: WalletCurrency.Usdt }
          : { id: SOURCE, accountId: OWNER.id, currency: WalletCurrency.Usdt },
      )
      mockFindAccountById.mockImplementation(async (id: string) =>
        id === DEST_ACCOUNT ? { id: DEST_ACCOUNT, level: 1, status } : OWNER,
      )
    }

    it.each(["closed", "locked", "pending"])(
      "disables the rule, folds the share and pushes the owner once when the destination is %s",
      async (status) => {
        destinationStatus(status)
        await seed()
        mockPayLeg.mockResolvedValue(new InactiveAccountError(DEST_ACCOUNT))

        const summary = await executePendingSplits({ now: T0 })

        expect(summary).toMatchObject({ claimed: 1, folded: 1, retried: 0 })
        expect(onlyRow()).toMatchObject({
          status: "failed",
          attempts: 1,
          lastError: "InactiveAccountError",
        })
        expect(mockDisableRule).toHaveBeenCalledTimes(1)
        expect(mockDisableRule).toHaveBeenCalledWith(SOURCE, DEST, expect.anything())
        expect(mockNotify).toHaveBeenCalledWith(
          expect.objectContaining({
            accountId: OWNER.id,
            phraseBase: "notification.paymentSplit.disabled",
            dataType: "payment_split_disabled",
            amountArg: "US$2.50",
          }),
        )
        // The share folded: the merchant gets it.
        expect(
          [...mockStore.rows.values()].some(
            (r) => r.destinationWalletId === SOURCE && r.status === "pending",
          ),
        ).toBe(true)
      },
    )

    it("pushes once across several rows of the same rule", async () => {
      destinationStatus("closed")
      await seed({ triggerKey: "a".repeat(64) })
      await seed({ shareCents: 300, triggerKey: "b".repeat(64) })
      mockPayLeg.mockResolvedValue(new InactiveAccountError(DEST_ACCOUNT))
      // Only the first disable flips `enabled`; the rule is already off after.
      mockDisableRule.mockResolvedValueOnce(true).mockResolvedValue(false)

      const summary = await executePendingSplits({ now: T0 })

      expect(summary).toMatchObject({ claimed: 2 })
      expect(mockDisableRule).toHaveBeenCalledTimes(2)
      // Exactly one push: the first row flipped the rule and told the owner
      // ("disabled"); the second row sees nothing flip, the rule still exists
      // (disabled, owner already told), so it folds silently. Both shares fold.
      expect(mockNotify).toHaveBeenCalledTimes(1)
      expect(mockNotify).toHaveBeenCalledWith(
        expect.objectContaining({ phraseBase: "notification.paymentSplit.disabled" }),
      )
    })

    it("keeps the rule enabled when the destination account cannot be read", async () => {
      destinationStatus("closed")
      mockFindAccountById.mockImplementation(async (id: string) =>
        id === DEST_ACCOUNT ? new UnknownRepositoryError("mongo down") : OWNER,
      )
      await seed()
      mockPayLeg.mockResolvedValue(new InactiveAccountError(DEST_ACCOUNT))

      await executePendingSplits({ now: T0 })

      expect(onlyRow()).toMatchObject({ status: "failed" })
      expect(mockDisableRule).not.toHaveBeenCalled()
      expect(mockNotify).toHaveBeenCalledWith(
        expect.objectContaining({ phraseBase: "notification.paymentSplit.failed" }),
      )
    })
  })

  it("retries a retryable error with 1/2/4/8 minute backoff, then fails at the attempt budget", async () => {
    await seed()
    mockPayLeg.mockResolvedValue(http429())

    let now = T0
    const expectedBackoffs = [1, 2, 4, 8]
    for (const [i, backoff] of expectedBackoffs.entries()) {
      await executePendingSplits({ now })
      expect(onlyRow()).toMatchObject({ status: "pending", attempts: i + 1 })
      const next = new Date(now.getTime() + backoff * 60_000)
      expect(onlyRow().nextAttemptAt).toEqual(next)

      // Not due yet: nothing is claimed a second early.
      await executePendingSplits({ now: new Date(next.getTime() - 1000) })
      expect(mockPayLeg).toHaveBeenCalledTimes(i + 1)
      now = next
    }

    await executePendingSplits({ now })
    expect(mockPayLeg).toHaveBeenCalledTimes(5)
    expect(onlyRow()).toMatchObject({ status: "failed", attempts: 5 })
    // Terminal: the share folds to the merchant.
    expect(
      [...mockStore.rows.values()].some(
        (r) => r.destinationWalletId === SOURCE && r.status === "pending",
      ),
    ).toBe(true)
  })

  it("runs every minute in production, so the 1-minute backoff step is real", () => {
    expect(PaymentSplitsConfig.loopIntervalMs).toBeLessThanOrEqual(splitRetryBackoffMs(1))
  })

  it("treats a marker write failure as retryable", async () => {
    await seed()
    mockPayLeg.mockResolvedValue(new InternalTransferMarkerError("mongo"))

    await executePendingSplits({ now: T0 })

    expect(onlyRow()).toMatchObject({ status: "pending", attempts: 1 })
    expect(mockNotify).not.toHaveBeenCalled()
  })

  it("lets only one of two concurrent executors claim a row", async () => {
    await seed()
    let release: (v: unknown) => void = () => undefined
    const sendReached = new Promise<void>((reached) => {
      mockPayLeg.mockImplementation(
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

    expect(mockPayLeg).toHaveBeenCalledTimes(1)
    expect(
      [firstSummary, secondSummary].map((s) => (s instanceof Error ? -1 : s.claimed)),
    ).toEqual([1, 0])
  })

  const seedMany = async (count: number) => {
    for (let i = 0; i < count; i++) {
      await mockStore.repo.insert({
        triggerKey: `${i}`.padStart(64, "c"),
        legKind: "share",
        ruleId: "rule-1",
        walletId: SOURCE,
        sourceIbexAccountId: SHADOW,
        destinationWalletId: DEST,
        currency: WalletCurrency.Usdt,
        grossMinor: "1000000",
        shareCents: 10,
        status: "pending",
        now: T0,
      })
    }
  }

  it("drains every due leg in one pass, with no fixed batch cap", async () => {
    await seedMany(120)
    mockPayLeg.mockResolvedValue(PaymentSendStatus.Success)

    expect(await executePendingSplits({ now: T0 })).toMatchObject({
      claimed: 120,
      sent: 120,
    })
    expect([...mockStore.rows.values()].every((r) => r.status === "sent")).toBe(true)
  })

  it("stops claiming once the time budget is spent", async () => {
    PaymentSplitsConfig.executorTimeBudgetMs = 1000
    await seedMany(3)
    mockPayLeg.mockResolvedValue(PaymentSendStatus.Success)
    // Each clock read advances 600ms: the deadline is set at 600 + 1000, the
    // first check (1200) claims one row, the second (1800) is past it.
    let t = 0
    const clock = () => (t += 600)

    expect(await executePendingSplits({ now: T0, clock })).toMatchObject({ claimed: 1 })
    expect(await executePendingSplits({ now: T0 })).toMatchObject({ claimed: 2 })
  })

  it("finishes the leg in flight but claims no new one once stopping", async () => {
    await seedMany(3)
    let stopping = false
    mockPayLeg.mockImplementation(async () => {
      // SIGTERM lands while the first leg is being sent.
      stopping = true
      return PaymentSendStatus.Success
    })

    expect(
      await executePendingSplits({ now: T0, shouldStop: () => stopping }),
    ).toMatchObject({ claimed: 1, sent: 1 })
    const statuses = [...mockStore.rows.values()].map((r) => r.status)
    expect(statuses.filter((s) => s === "sent")).toHaveLength(1)
    expect(statuses.filter((s) => s === "pending")).toHaveLength(2)
    expect(statuses).not.toContain("sending")
  })

  describe("IBEX errors from payInvoice", () => {
    // onProgress ran (the marker was written), so Ibex.payInvoice was called:
    // anything but a definite rejection may have debited the shadow.
    const afterPayReached =
      (error: Error) =>
      async (args: { onProgress?: (p: { payInvoiceReached: boolean }) => void }) => {
        args.onProgress?.({ payInvoiceReached: true })
        return error
      }

    const httpError = (httpCode?: number) => {
      const err = new IbexError(new Error(`IBEX ${httpCode ?? "ECONNRESET"}`))
      if (httpCode !== undefined) {
        Object.defineProperty(err, "httpCode", { value: httpCode })
      }
      return err
    }

    it.each([
      ["a 500", httpError(500)],
      ["a 502", httpError(502)],
      ["a 408 timeout", httpError(408)],
      ["a transport error / timeout with no status", httpError()],
    ])(
      "marks %s unknown, alerts ops, never pushes the owner a failure, never re-sends",
      async (_label, error) => {
        await seed()
        mockPayLeg.mockImplementation(afterPayReached(error))

        const summary = await executePendingSplits({ now: T0 })

        expect(summary).toMatchObject({ claimed: 1, unknown: 1, failed: 0, retried: 0 })
        expect(onlyRow()).toMatchObject({ status: "unknown", attempts: 1 })
        expect(mockNotifyOps).toHaveBeenCalledWith(
          expect.objectContaining({ phase: "split-unknown", status: "failed" }),
        )
        expect(mockNotify).not.toHaveBeenCalled()

        await executePendingSplits({ now: minutes(60) })
        expect(mockPayLeg).toHaveBeenCalledTimes(1)
      },
    )

    it("fails a definitive 400 rejection, folds the share and pushes the owner", async () => {
      await seed()
      mockPayLeg.mockImplementation(afterPayReached(httpError(400)))

      const summary = await executePendingSplits({ now: T0 })

      expect(summary).toMatchObject({ claimed: 1, folded: 1, unknown: 0 })
      expect(onlyRow()).toMatchObject({ status: "failed", attempts: 1 })
      expect(mockNotifyOps).not.toHaveBeenCalled()
      expect(mockNotify).toHaveBeenCalledWith(
        expect.objectContaining({ phraseBase: "notification.paymentSplit.failed" }),
      )
    })

    it("still retries an IBEX 429 (rejected before anything moved)", async () => {
      await seed()
      mockPayLeg.mockImplementation(afterPayReached(httpError(429)))

      await executePendingSplits({ now: T0 })

      expect(onlyRow()).toMatchObject({ status: "pending", attempts: 1 })
      expect(mockNotifyOps).not.toHaveBeenCalled()
    })
  })

  describe("IBEX errors from addInvoice (before payInvoice)", () => {
    // The send never reached Ibex.payInvoice: only the recipient invoice was
    // being minted, so nothing moved.
    const beforePayInvoice = (error: Error) => async () => error

    const httpError = (httpCode?: number) => {
      const err = new IbexError(new Error(`IBEX ${httpCode ?? "ECONNRESET"}`))
      if (httpCode !== undefined) {
        Object.defineProperty(err, "httpCode", { value: httpCode })
      }
      return err
    }

    it("passes an onProgress callback to the send", async () => {
      await seed()
      mockPayLeg.mockResolvedValue(PaymentSendStatus.Success)

      await executePendingSplits({ now: T0 })

      expect(mockPayLeg.mock.calls[0][0]).toEqual(
        expect.objectContaining({ onProgress: expect.any(Function) }),
      )
    })

    it.each([
      ["a 500", httpError(500)],
      ["a transport error with no status", httpError()],
      ["a missing bolt11", new UnexpectedIbexResponse("Bolt11 field not found.")],
    ])(
      "retries %s as pending with no ops alert and no owner push",
      async (_label, error) => {
        await seed()
        mockPayLeg.mockImplementationOnce(beforePayInvoice(error))

        const summary = await executePendingSplits({ now: T0 })

        expect(summary).toMatchObject({ claimed: 1, retried: 1, unknown: 0, failed: 0 })
        expect(onlyRow()).toMatchObject({ status: "pending", attempts: 1 })
        expect(mockNotifyOps).not.toHaveBeenCalled()
        expect(mockNotify).not.toHaveBeenCalled()

        // The retry re-runs the send and pays.
        mockPayLeg.mockResolvedValue(PaymentSendStatus.Success)
        await executePendingSplits({ now: minutes(1) })
        expect(onlyRow()).toMatchObject({ status: "sent", attempts: 2 })
      },
    )

    it("fails a definitive 400 from addInvoice at once", async () => {
      await seed()
      mockPayLeg.mockImplementation(beforePayInvoice(httpError(400)))

      expect(await executePendingSplits({ now: T0 })).toMatchObject({ folded: 1 })
      expect(onlyRow()).toMatchObject({ status: "failed", attempts: 1 })
      expect(mockNotifyOps).not.toHaveBeenCalled()
    })
  })

  describe("repository errors before the send", () => {
    it.each([
      ["the wallet lookup", "wallet"],
      ["the account lookup", "account"],
    ])(
      "retries a transient error from %s instead of failing the leg",
      async (_label, which) => {
        await seed()
        const blip = new UnknownRepositoryError("primary stepdown")
        if (which === "wallet") mockFindWalletById.mockResolvedValueOnce(blip)
        else mockFindAccountById.mockResolvedValueOnce(blip)
        mockPayLeg.mockResolvedValue(PaymentSendStatus.Success)

        expect(await executePendingSplits({ now: T0 })).toMatchObject({ retried: 1 })
        expect(onlyRow()).toMatchObject({ status: "pending", attempts: 1 })
        expect(mockPayLeg).not.toHaveBeenCalled()
        expect(mockNotify).not.toHaveBeenCalled()

        await executePendingSplits({ now: minutes(1) })
        expect(onlyRow()).toMatchObject({ status: "sent", attempts: 2 })
      },
    )

    it("fails a transient error once the attempt budget is spent", async () => {
      await seed()
      mockFindWalletById.mockResolvedValue(new UnknownRepositoryError("mongo down"))

      let now = T0
      for (const backoff of [1, 2, 4, 8]) {
        await executePendingSplits({ now })
        now = new Date(now.getTime() + backoff * 60_000)
      }
      await executePendingSplits({ now })

      expect(onlyRow()).toMatchObject({ status: "failed", attempts: 5 })
      expect(mockPayLeg).not.toHaveBeenCalled()
    })

    it.each([
      ["the wallet is gone", "wallet", new CouldNotFindWalletFromIdError()],
      ["the account is gone", "account", new CouldNotFindAccountFromIdError()],
    ])("fails at once when %s", async (_label, which, error) => {
      await seed()
      if (which === "wallet") mockFindWalletById.mockResolvedValue(error)
      else mockFindAccountById.mockResolvedValue(error)

      expect(await executePendingSplits({ now: T0 })).toMatchObject({ failed: 1 })
      expect(onlyRow()).toMatchObject({ status: "failed", attempts: 1 })
      expect(mockPayLeg).not.toHaveBeenCalled()
    })
  })

  describe("wall-clock stamps", () => {
    it("stamps the claim and the outcome with the clock, not the pass's now", async () => {
      await seed()
      // The pass's `now` is 11 minutes old by the time the leg is claimed
      // (a slow reconcile ran first).
      const wallClock = minutes(11).getTime()
      let updatedAtWhileSending: Date | undefined
      mockPayLeg.mockImplementation(async () => {
        updatedAtWhileSending = onlyRow().updatedAt
        return PaymentSendStatus.Success
      })

      await executePendingSplits({ now: T0, clock: () => wallClock })

      expect(updatedAtWhileSending).toEqual(new Date(wallClock))
      expect(onlyRow()).toMatchObject({ status: "sent", updatedAt: new Date(wallClock) })
    })

    it("logs an error when the stale sweep took the row while it was being paid", async () => {
      await seed()
      mockPayLeg.mockImplementation(async () => {
        // Another replica's sweep marks the row unknown mid-send.
        await mockStore.repo.markNextStaleUnknown(new Date(8.64e15), new Date())
        return PaymentSendStatus.Success
      })

      await executePendingSplits({ now: T0 })

      // The sweep's `unknown` is never overwritten, but the real outcome is
      // logged for the human resolving it.
      expect(onlyRow()).toMatchObject({ status: "unknown" })
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ executionId: onlyRow().id, outcome: "sent" }),
        expect.stringContaining("outcome lost"),
      )
    })
  })

  describe("internal-transfer re-check", () => {
    it("drops a share leg whose trigger hash was marked internal after it was built", async () => {
      await seed()
      mockIsInternal.mockResolvedValue(true)

      const summary = await executePendingSplits({ now: T0 })

      expect(summary).toMatchObject({ claimed: 1, failed: 1 })
      expect(mockIsInternal).toHaveBeenCalledWith("a".repeat(64))
      expect(onlyRow()).toMatchObject({
        status: "failed",
        lastError: "internal_transfer",
      })
      expect(mockPayLeg).not.toHaveBeenCalled()
    })

    it("still pays the NET leg when the trigger hash is internal — the money is in the shadow and belongs to the merchant", async () => {
      await seed({ legKind: "net", destinationWalletId: SOURCE })
      mockIsInternal.mockResolvedValue(true)
      mockPayLeg.mockResolvedValue(PaymentSendStatus.Success)

      await executePendingSplits({ now: T0 })

      expect(onlyRow()).toMatchObject({ status: "sent" })
      expect(mockPayLeg).toHaveBeenCalledTimes(1)
    })

    it("retries when the marker cannot be read, without sending", async () => {
      await seed()
      mockIsInternal.mockResolvedValue(new RepositoryError("mongo"))

      await executePendingSplits({ now: T0 })

      expect(onlyRow()).toMatchObject({ status: "pending", attempts: 1 })
      expect(mockPayLeg).not.toHaveBeenCalled()
    })
  })

  it("does nothing while the feature flag is off", async () => {
    await seed()
    PaymentSplitsConfig.enabled = false

    expect(await executePendingSplits({ now: T0 })).toMatchObject({ claimed: 0 })
    expect(onlyRow()).toMatchObject({ status: "pending" })
    expect(mockPayLeg).not.toHaveBeenCalled()
  })

  const httpError = (httpCode?: number) => {
    const err = new IbexError(new Error(`IBEX ${httpCode ?? "ECONNRESET"}`))
    if (httpCode !== undefined) {
      Object.defineProperty(err, "httpCode", { value: httpCode })
    }
    return err
  }
  const http429 = () => httpError(429)

  describe("error classifiers", () => {
    it("isRetryableSplitError: 429 always, post-reach non-definitive IbexError, marker errors", () => {
      expect(isRetryableSplitError(httpError(429))).toBe(true)
      expect(isRetryableSplitError(httpError(500))).toBe(true)
      expect(isRetryableSplitError(httpError(400))).toBe(false)
      expect(isRetryableSplitError(new InternalTransferMarkerError("mongo"))).toBe(true)
      expect(isRetryableSplitError(new InactiveAccountError())).toBe(false)
    })

    it("isAmbiguousSplitSendError: post-reach non-definitive IbexError only", () => {
      expect(isAmbiguousSplitSendError(httpError(500), { payInvoiceReached: true })).toBe(
        true,
      )
      expect(isAmbiguousSplitSendError(httpError(400), { payInvoiceReached: true })).toBe(
        false,
      )
      expect(isAmbiguousSplitSendError(httpError(500), {})).toBe(false)
      expect(isAmbiguousSplitSendError(new InternalTransferMarkerError("m"), {})).toBe(
        false,
      )
    })
  })
})
