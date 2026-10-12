const mockNotifyOpsEvent = jest.fn()

jest.mock("@services/alerts/ops-events", () => ({
  notifyOpsEvent: (...args: unknown[]) => mockNotifyOpsEvent(...args),
}))

jest.mock("@services/mongoose/payment-split-executions", () => ({
  PaymentSplitExecutionsRepository: jest.fn(() => mockStore.repo),
}))

import { PaymentSplitsConfig } from "@config"
import {
  STALE_SENDING_MS,
  sweepStaleSplits,
} from "@app/payment-splits/sweep-stale-splits"

import { createFakeExecutionsStore } from "./fake-executions-store"

// Read lazily by the repository mock above, so defining it after the imports
// is safe: the mock factory only captures the reference.
const mockStore = createFakeExecutionsStore()

const T0 = new Date("2026-10-11T12:00:00Z")

const seedSending = async (claimedAt: Date) => {
  await mockStore.repo.insert({
    triggerKey: "a".repeat(64),
    ruleId: `rule-${mockStore.rows.size}`,
    walletId: "source",
    destinationWalletId: "dest",
    currency: "USDT",
    triggerAmountMinor: "1000000",
    shareCents: 100,
    status: "pending",
    now: claimedAt,
  })
  await mockStore.repo.claimNextDue(claimedAt, claimedAt)
}

const originalEnabled = PaymentSplitsConfig.enabled

beforeEach(() => {
  jest.clearAllMocks()
  mockStore.rows.clear()
  PaymentSplitsConfig.enabled = true
})

afterAll(() => {
  PaymentSplitsConfig.enabled = originalEnabled
})

describe("sweepStaleSplits", () => {
  it("marks a row stuck in sending for over 10 minutes unknown and alerts ops, without sending", async () => {
    await seedSending(T0)
    const now = new Date(T0.getTime() + STALE_SENDING_MS + 1)

    expect(await sweepStaleSplits({ now })).toEqual({ markedUnknown: 1 })
    expect([...mockStore.rows.values()][0]).toMatchObject({ status: "unknown" })
    expect(mockNotifyOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        flow: "transfer",
        phase: "split-unknown",
        status: "failed",
      }),
    )

    // An unknown row is never claimable again.
    expect(await mockStore.repo.claimNextDue(new Date(now.getTime() + 3_600_000))).toBe(
      null,
    )
  })

  it("leaves a row that is still within the sending window alone", async () => {
    await seedSending(T0)

    expect(
      await sweepStaleSplits({ now: new Date(T0.getTime() + STALE_SENDING_MS - 1000) }),
    ).toEqual({ markedUnknown: 0 })
    expect([...mockStore.rows.values()][0]).toMatchObject({ status: "sending" })
    expect(mockNotifyOpsEvent).not.toHaveBeenCalled()
  })

  it("does nothing while the feature flag is off", async () => {
    await seedSending(T0)
    PaymentSplitsConfig.enabled = false

    expect(await sweepStaleSplits({ now: new Date(T0.getTime() + 86_400_000) })).toEqual({
      markedUnknown: 0,
    })
  })
})
