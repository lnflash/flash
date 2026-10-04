const mockFygaroConfig = {
  retry: { lookbackDays: 7 } as { lookbackDays?: number } | undefined,
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
const mockRedisGet = jest.fn()
jest.mock("@services/redis", () => ({
  redis: {
    set: (...args: unknown[]) => mockRedisSet(...args),
    get: (...args: unknown[]) => mockRedisGet(...args),
  },
}))

import {
  creditedMarkerTtlSeconds,
  markFygaroCredited,
  MIN_CREDITED_MARKER_TTL_DAYS,
  readFygaroCreditedMarker,
} from "@services/fygaro/credited-marker"

const DAY = 24 * 60 * 60

beforeEach(() => {
  jest.clearAllMocks()
  mockFygaroConfig.retry = { lookbackDays: 7 }
  mockRedisSet.mockResolvedValue("OK")
})

describe("creditedMarkerTtlSeconds", () => {
  it("is a fixed 30-day floor at the default 7-day lookback, not lookback + 1", () => {
    expect(MIN_CREDITED_MARKER_TTL_DAYS).toBe(30)
    expect(creditedMarkerTtlSeconds()).toBe(30 * DAY)
  })

  it("does NOT shrink or grow with a lookback raised after the fact (7 → 14 keeps 30 days)", () => {
    // The double-pay path this closes: marker written under lookbackDays=7
    // with a 8-day TTL, ops raises lookbackDays to 14, a row credited 9 days
    // ago whose promotion failed is listed again with its marker gone.
    mockFygaroConfig.retry = { lookbackDays: 14 }
    expect(creditedMarkerTtlSeconds()).toBe(30 * DAY)
  })

  it("still outlives a lookback configured past the floor (lookback + 1)", () => {
    mockFygaroConfig.retry = { lookbackDays: 45 }
    expect(creditedMarkerTtlSeconds()).toBe(46 * DAY)
  })

  it("uses the 7-day default lookback when the retry block is absent", () => {
    mockFygaroConfig.retry = undefined
    expect(creditedMarkerTtlSeconds()).toBe(30 * DAY)
  })
})

describe("markFygaroCredited", () => {
  it("writes the net under the transaction key with the floor TTL", async () => {
    await markFygaroCredited({ transactionId: "tx-1", netCents: 6602 })
    expect(mockRedisSet).toHaveBeenCalledWith(
      "fygaro:sweep-credited:tx-1",
      "6602",
      "EX",
      30 * DAY,
    )
  })

  it("fails open on a Redis write error (the credit already happened)", async () => {
    mockRedisSet.mockRejectedValue(new Error("redis down"))
    await expect(
      markFygaroCredited({ transactionId: "tx-1", netCents: 6602 }),
    ).resolves.toBeUndefined()
  })
})

describe("readFygaroCreditedMarker", () => {
  it("reports not credited when no marker exists", async () => {
    mockRedisGet.mockResolvedValue(null)
    expect(await readFygaroCreditedMarker("tx-1")).toEqual({
      known: true,
      credited: false,
    })
  })

  it("reports credited with the recorded net", async () => {
    mockRedisGet.mockResolvedValue("6602")
    expect(await readFygaroCreditedMarker("tx-1")).toEqual({
      known: true,
      credited: true,
      netCents: 6602,
    })
  })

  it("reports credited without a net when the stored value is not a positive number", async () => {
    mockRedisGet.mockResolvedValue("garbage")
    expect(await readFygaroCreditedMarker("tx-1")).toEqual({
      known: true,
      credited: true,
      netCents: undefined,
    })
  })

  it("reports unknown (not 'not credited') when Redis cannot be read", async () => {
    mockRedisGet.mockRejectedValue(new Error("redis down"))
    expect(await readFygaroCreditedMarker("tx-1")).toEqual({ known: false })
  })
})
