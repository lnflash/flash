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
  stopPaymentSplitsLoopOnShutdown,
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
    expect(mockExecute).toHaveBeenCalledWith({
      now: NOW,
      shouldStop: expect.any(Function),
    })
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

  it("hands the executor and the sweep a clock read after a slow reconcile", async () => {
    // A reconcile has no time bound. With a `now` captured at the start of the
    // tick, the executor would stamp claims 11 minutes in the past and another
    // replica's stale sweep would take a row that is still being paid.
    const after = new Date(NOW.getTime() + 11 * 60_000)
    jest.useFakeTimers({ now: NOW })
    mockReconcile.mockImplementation(async ({ now }: { now: Date }) => {
      expect(now).toEqual(NOW)
      jest.setSystemTime(after)
      return { recorded: 0, errors: 0 }
    })

    try {
      await runPaymentSplitsTick()
    } finally {
      jest.useRealTimers()
    }

    expect(mockReconcile).toHaveBeenCalledTimes(1)
    expect(mockExecute.mock.calls[0][0].now).toEqual(after)
    expect(mockSweep.mock.calls[0][0].now).toEqual(after)
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

  it("starts a timer when enabled", async () => {
    jest.useFakeTimers()
    try {
      const loop = startPaymentSplitsLoop()
      expect(loop).toBeDefined()
      await loop?.stop()
    } finally {
      jest.clearAllTimers()
      jest.useRealTimers()
    }
  })
})

describe("startPaymentSplitsLoop stop()", () => {
  // Lets the tick's awaits (reconcile lease, reconcile) run under fake timers.
  const flushMicrotasks = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }
  const deferred = () => {
    let resolve!: (value: unknown) => void
    const promise = new Promise((r) => {
      resolve = r
    })
    return { promise, resolve }
  }

  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it("waits for the tick in flight, which claims no new row once stopping", async () => {
    jest.useFakeTimers()
    const send = deferred()
    const claimsAfterStop: boolean[] = []
    // Stands in for the executor: one send in flight, then a claim check of the
    // kind executePendingSplits makes before every claimNextDue.
    mockExecute.mockImplementation(
      async ({ shouldStop }: { shouldStop: () => boolean }) => {
        await send.promise
        claimsAfterStop.push(!shouldStop())
        return { claimed: 1 }
      },
    )

    const loop = startPaymentSplitsLoop()!
    jest.advanceTimersByTime(30_000)
    await flushMicrotasks()
    expect(mockExecute).toHaveBeenCalledTimes(1)

    let stopped = false
    const stopping = loop.stop().then(() => {
      stopped = true
    })
    await flushMicrotasks()
    expect(stopped).toBe(false)

    send.resolve(undefined)
    await stopping

    expect(stopped).toBe(true)
    // The executor saw the stop flag after its send, so it claims nothing more.
    expect(claimsAfterStop).toEqual([false])
    // The sweep is skipped once stopping.
    expect(mockSweep).not.toHaveBeenCalled()
  })

  it("starts no tick after stop()", async () => {
    jest.useFakeTimers()
    const loop = startPaymentSplitsLoop()!

    await loop.stop()
    jest.advanceTimersByTime(30_000 + PaymentSplitsConfig.loopIntervalMs * 3)
    await flushMicrotasks()

    expect(mockExecute).not.toHaveBeenCalled()
    expect(mockReconcile).not.toHaveBeenCalled()
  })
})

describe("runPaymentSplitsTick shouldStop", () => {
  it("does nothing once stopping", async () => {
    await runPaymentSplitsTick({ now: NOW, shouldStop: () => true })

    expect(mockReconcile).not.toHaveBeenCalled()
    expect(mockExecute).not.toHaveBeenCalled()
    expect(mockSweep).not.toHaveBeenCalled()
  })
})

describe("stopPaymentSplitsLoopOnShutdown", () => {
  it("stops the loop on SIGTERM, then re-raises the signal with its listeners gone", async () => {
    const before = process.listenerCount("SIGTERM")
    let finishStop!: () => void
    const stop = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finishStop = resolve
        }),
    )
    const kill = jest.spyOn(process, "kill").mockImplementation(() => true)
    try {
      stopPaymentSplitsLoopOnShutdown({ stop })
      expect(process.listenerCount("SIGTERM")).toBe(before + 1)

      process.emit("SIGTERM", "SIGTERM")
      expect(stop).toHaveBeenCalledTimes(1)
      expect(process.listenerCount("SIGTERM")).toBe(before)
      await Promise.resolve()
      expect(kill).not.toHaveBeenCalled()

      finishStop()
      await new Promise((r) => setImmediate(r))
      expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM")
    } finally {
      kill.mockRestore()
    }
  })
})
