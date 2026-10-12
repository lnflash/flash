const mockReconcile = jest.fn()
const mockExecute = jest.fn()
const mockSweep = jest.fn()
const mockRedisSet = jest.fn()

jest.mock("@app/payment-splits/reconcile-splits", () => ({
  reconcileSplits: (...args: unknown[]) => mockReconcile(...args),
}))
jest.mock("@app/payment-splits/execute-pending-splits", () => ({
  executePendingSplits: (...args: unknown[]) => mockExecute(...args),
}))
jest.mock("@app/payment-splits/sweep-stale-splits", () => ({
  sweepStaleSplits: (...args: unknown[]) => mockSweep(...args),
}))
jest.mock("@services/redis", () => ({
  redis: { set: (...args: unknown[]) => mockRedisSet(...args) },
}))

import { PaymentSplitsConfig } from "@config"
import {
  runPaymentSplitsTick,
  startPaymentSplitsLoop,
} from "@app/payment-splits/split-loop"
import { splitRetryBackoffMs } from "@domain/payment-splits"

const NOW = new Date("2026-10-11T12:00:00Z")
const original = { ...PaymentSplitsConfig }

beforeEach(() => {
  jest.clearAllMocks()
  Object.assign(PaymentSplitsConfig, original, { enabled: true })
  mockReconcile.mockResolvedValue({ recorded: 0, errors: 0 })
  mockExecute.mockResolvedValue({ claimed: 0 })
  mockSweep.mockResolvedValue({ markedUnknown: 0 })
  mockRedisSet.mockResolvedValue("OK")
})

afterAll(() => {
  Object.assign(PaymentSplitsConfig, original)
})

describe("runPaymentSplitsTick", () => {
  it("reconciles on its own cadence, then executes and sweeps", async () => {
    await runPaymentSplitsTick({ now: NOW })

    expect(mockReconcile).toHaveBeenCalledWith({
      cadenceMs: PaymentSplitsConfig.reconcileIntervalMs,
      now: NOW,
    })
    expect(mockRedisSet).toHaveBeenCalledWith(
      "payment-splits:reconcile:lease",
      "1",
      "EX",
      Math.floor((PaymentSplitsConfig.reconcileIntervalMs * 0.9) / 1000),
      "NX",
    )
    expect(mockExecute).toHaveBeenCalledWith({ now: NOW })
    expect(mockSweep).toHaveBeenCalledWith({ now: NOW })
  })

  it("skips the reconcile while another tick holds the lease, but still executes", async () => {
    mockRedisSet.mockResolvedValue(null)

    await runPaymentSplitsTick({ now: NOW })

    expect(mockReconcile).not.toHaveBeenCalled()
    expect(mockExecute).toHaveBeenCalledTimes(1)
    expect(mockSweep).toHaveBeenCalledTimes(1)
  })

  it("reconciles anyway when Redis is unreachable (fail-open)", async () => {
    mockRedisSet.mockRejectedValue(new Error("redis down"))

    await runPaymentSplitsTick({ now: NOW })

    expect(mockReconcile).toHaveBeenCalledTimes(1)
  })

  it("keeps executing when the reconcile fails", async () => {
    mockReconcile.mockResolvedValue(new Error("mongo"))

    await runPaymentSplitsTick({ now: NOW })

    expect(mockExecute).toHaveBeenCalledTimes(1)
  })

  it("does nothing while the feature flag is off", async () => {
    PaymentSplitsConfig.enabled = false

    await runPaymentSplitsTick({ now: NOW })

    expect(mockReconcile).not.toHaveBeenCalled()
    expect(mockExecute).not.toHaveBeenCalled()
  })
})

describe("startPaymentSplitsLoop", () => {
  it("is not started while the feature flag is off", () => {
    PaymentSplitsConfig.enabled = false
    expect(startPaymentSplitsLoop()).toBeUndefined()
  })

  it("runs often enough for the executor's 1-minute retry step", () => {
    expect(PaymentSplitsConfig.loopIntervalMs).toBeLessThanOrEqual(splitRetryBackoffMs(1))
    expect(PaymentSplitsConfig.reconcileIntervalMs).toBeLessThan(
      PaymentSplitsConfig.cronIntervalMs,
    )
  })

  it("starts a timer when enabled", () => {
    jest.useFakeTimers()
    try {
      const timer = startPaymentSplitsLoop()
      expect(timer).toBeDefined()
      clearInterval(timer)
    } finally {
      jest.clearAllTimers()
      jest.useRealTimers()
    }
  })
})
