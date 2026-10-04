const mockFygaroConfig = {
  enabled: true,
  credit: { enabled: true } as { enabled: boolean } | undefined,
  float: { checkIntervalMs: 900000 } as { checkIntervalMs?: number } | undefined,
}

jest.mock("@config", () => ({
  get FygaroConfig() {
    return mockFygaroConfig
  },
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

const mockRedisSet = jest.fn()
jest.mock("@services/redis", () => ({
  redis: { set: (...args: unknown[]) => mockRedisSet(...args) },
}))

const mockCheckFloat = jest.fn()
jest.mock("@services/fygaro/float-monitor", () => ({
  checkFygaroTreasuryFloat: (...args: unknown[]) => mockCheckFloat(...args),
}))

const mockSweep = jest.fn()
jest.mock("@services/fygaro/stranded-credit-sweep", () => ({
  retryStrandedFygaroCredits: (...args: unknown[]) => mockSweep(...args),
}))

import {
  runFygaroTreasuryTick,
  startFygaroTreasuryLoop,
} from "@services/fygaro/treasury-loop"

const reading = (balanceUsd: number, criticalFloorUsd = 500) => ({
  balanceUsd,
  floorUsd: 2000,
  criticalFloorUsd,
  dailyBurnUsd: 100,
  runwayDays: balanceUsd / 100,
  severity: "warning" as const,
})

beforeEach(() => {
  jest.clearAllMocks()
  jest.useRealTimers()
  mockFygaroConfig.enabled = true
  mockFygaroConfig.credit = { enabled: true }
  mockFygaroConfig.float = { checkIntervalMs: 900000 }
  mockRedisSet.mockResolvedValue("OK")
  mockCheckFloat.mockResolvedValue(reading(3000))
  mockSweep.mockResolvedValue({})
})

describe("runFygaroTreasuryTick", () => {
  it("checks the float then sweeps with the balance ABOVE the critical-floor reserve, never the full balance", async () => {
    await runFygaroTreasuryTick()

    expect(mockCheckFloat).toHaveBeenCalledTimes(1)
    expect(mockSweep).toHaveBeenCalledWith({ availableUsd: 2500 })
  })

  it("keeps the critical floor as a reserve: balance $600, floor $500 → the sweep may spend $100, so a $280 row stays uncovered", async () => {
    mockCheckFloat.mockResolvedValue(reading(600))

    await runFygaroTreasuryTick()

    // Full-balance hand-off would be { availableUsd: 600 } and two $280 rows
    // would drain the float to $40 — through the floor the tick just gated on.
    expect(mockSweep).toHaveBeenCalledWith({ availableUsd: 100 })
  })

  it("does not sweep when the float check could not run", async () => {
    mockCheckFloat.mockResolvedValue(undefined)

    await runFygaroTreasuryTick()

    expect(mockSweep).not.toHaveBeenCalled()
  })

  it("does not sweep while the float is below the critical floor (live traffic gets the last dollars)", async () => {
    mockCheckFloat.mockResolvedValue(reading(400))

    await runFygaroTreasuryTick()

    expect(mockSweep).not.toHaveBeenCalled()
  })

  it("sweeps in the warning tier — there is runway, and the backlog is what the refill was for", async () => {
    mockCheckFloat.mockResolvedValue(reading(1500))

    await runFygaroTreasuryTick()

    expect(mockSweep).toHaveBeenCalledWith({ availableUsd: 1000 })
  })

  it("sweeps exactly at the critical floor (not below it) — with nothing to spend, so only the processed-marker and aged-out checks run", async () => {
    mockCheckFloat.mockResolvedValue(reading(500))

    await runFygaroTreasuryTick()

    expect(mockSweep).toHaveBeenCalledTimes(1)
    expect(mockSweep).toHaveBeenCalledWith({ availableUsd: 0 })
  })
})

describe("startFygaroTreasuryLoop", () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it("does not start when fygaro or auto-credit is off", () => {
    mockFygaroConfig.credit = { enabled: false }
    expect(startFygaroTreasuryLoop()).toBeUndefined()
    mockFygaroConfig.credit = { enabled: true }
    mockFygaroConfig.enabled = false
    expect(startFygaroTreasuryLoop()).toBeUndefined()
  })

  it("runs a first tick shortly after boot and then on the configured interval", async () => {
    jest.useFakeTimers()
    mockFygaroConfig.float = { checkIntervalMs: 120000 }

    const timer = startFygaroTreasuryLoop()
    expect(timer).toBeDefined()
    expect(mockCheckFloat).not.toHaveBeenCalled()

    await jest.advanceTimersByTimeAsync(30000)
    expect(mockCheckFloat).toHaveBeenCalledTimes(1)

    await jest.advanceTimersByTimeAsync(120000)
    expect(mockCheckFloat).toHaveBeenCalledTimes(2)

    clearInterval(timer)
  })

  it("claims a Redis lease per tick with a TTL just under the interval, so one replica runs", async () => {
    jest.useFakeTimers()
    mockFygaroConfig.float = { checkIntervalMs: 120000 }

    const timer = startFygaroTreasuryLoop()
    await jest.advanceTimersByTimeAsync(30000)

    expect(mockRedisSet).toHaveBeenCalledWith(
      "fygaro:treasury-loop:lease",
      "1",
      "EX",
      108,
      "NX",
    )
    clearInterval(timer)
  })

  it("skips the tick when another replica holds the lease", async () => {
    jest.useFakeTimers()
    mockRedisSet.mockResolvedValue(null)

    const timer = startFygaroTreasuryLoop()
    await jest.advanceTimersByTimeAsync(30000)

    expect(mockCheckFloat).not.toHaveBeenCalled()
    clearInterval(timer)
  })

  it("runs anyway when Redis is unavailable (fail-open: a blip must not silence the float check)", async () => {
    jest.useFakeTimers()
    mockRedisSet.mockRejectedValue(new Error("redis down"))

    const timer = startFygaroTreasuryLoop()
    await jest.advanceTimersByTimeAsync(30000)

    expect(mockCheckFloat).toHaveBeenCalledTimes(1)
    clearInterval(timer)
  })

  it("clamps the interval to a one-minute minimum", async () => {
    jest.useFakeTimers()
    mockFygaroConfig.float = { checkIntervalMs: 5 }

    const timer = startFygaroTreasuryLoop()
    // First run at t=30s; the interval (clamped to 60s) first fires at t=60s.
    await jest.advanceTimersByTimeAsync(30000)
    expect(mockCheckFloat).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(29000)
    expect(mockCheckFloat).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(1000)
    expect(mockCheckFloat).toHaveBeenCalledTimes(2)
    clearInterval(timer)
  })

  it("survives a tick that throws", async () => {
    jest.useFakeTimers()
    mockCheckFloat
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(reading(3000))
    mockFygaroConfig.float = { checkIntervalMs: 60000 }

    const timer = startFygaroTreasuryLoop()
    await jest.advanceTimersByTimeAsync(30000)
    await jest.advanceTimersByTimeAsync(60000)

    expect(mockCheckFloat).toHaveBeenCalledTimes(2)
    expect(mockSweep).toHaveBeenCalledTimes(1)
    clearInterval(timer)
  })
})
