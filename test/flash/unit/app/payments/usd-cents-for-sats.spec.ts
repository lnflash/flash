const mockCentsPerSat = jest.fn()
jest.mock("@app/prices/mid-price", () => ({
  usdCentsPerSatMidPrice: () => mockCentsPerSat(),
}))

const mockMarginBps = jest.fn<number, []>(() => 50)
jest.mock("@config", () => ({
  getOnChainBtcDenominatedSendMarginBps: () => mockMarginBps(),
}))

const mockAddAttributes = jest.fn()
jest.mock("@services/tracing", () => ({
  addAttributesToCurrentSpan: (attributes: unknown) => mockAddAttributes(attributes),
}))

import { usdCentsToDeliverSats } from "@app/payments/usd-cents-for-sats"

import { InvalidSendAmountError } from "@domain/payments/errors"
import { PriceNotAvailableError, UnknownPriceServiceError } from "@domain/price"

// 0.06 cents a sat is $60,000 a bitcoin.
const CENTS_PER_SAT = 0.06

const convert = async (sats: number) => {
  const result = await usdCentsToDeliverSats(sats)
  if (result instanceof Error) throw result
  return result
}

describe("usdCentsToDeliverSats", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCentsPerSat.mockResolvedValue(CENTS_PER_SAT)
    mockMarginBps.mockReturnValue(50)
  })

  it("prices the sats at the mid rate, adds the margin and rounds up to a whole cent", async () => {
    // 100,000 sats = 6,000.00 cents; +0.5% = 6,030.00
    expect(await convert(100_000)).toEqual({ cents: 6030, marginBps: 50 })
    // 6,000 sats = 360.00 cents; +0.5% = 361.8 -> 362
    expect((await convert(6_000)).cents).toBe(362)
  })

  it("never rounds down, even when the amount is worth a fraction of a cent", async () => {
    // 1 sat = 0.06 cents; a nearest-cent rounding would send nothing.
    expect((await convert(1)).cents).toBe(1)
    // 1,204 sats = 72.24 cents; +0.5% = 72.60 -> 73, not 72 or 73 by luck
    expect((await convert(1_204)).cents).toBe(73)
  })

  it("with no margin still rounds up, never to the nearest", async () => {
    mockMarginBps.mockReturnValue(0)
    // 1,201 sats = 72.06 cents -> 73
    expect(await convert(1_201)).toEqual({ cents: 73, marginBps: 0 })
  })

  it("sends at least the marked-up value for every amount, and less than a cent more", async () => {
    for (const marginBps of [0, 25, 50, 100, 1000]) {
      mockMarginBps.mockReturnValue(marginBps)
      for (const centsPerSat of [0.0598123, 0.06, 0.1234567]) {
        mockCentsPerSat.mockResolvedValue(centsPerSat)
        for (const sats of [1, 546, 1_204, 6_000, 25_000, 1_234_567, 100_000_000]) {
          const { cents } = await convert(sats)
          const marked = sats * centsPerSat * (1 + marginBps / 10_000)
          expect(Number.isInteger(cents)).toBe(true)
          expect(cents).toBeGreaterThanOrEqual(marked)
          // One cent of rounding, plus room for floating-point error upward.
          expect(cents - marked).toBeLessThan(1.000001)
        }
      }
    }
  })

  it("applies the configured margin, not a fixed one", async () => {
    mockMarginBps.mockReturnValue(100)
    // 100,000 sats = 6,000 cents; +1% = 6,060
    expect(await convert(100_000)).toEqual({ cents: 6060, marginBps: 100 })
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    "refuses %p sats without reading the price",
    async (sats) => {
      expect(await usdCentsToDeliverSats(sats)).toBeInstanceOf(InvalidSendAmountError)
      expect(mockCentsPerSat).not.toHaveBeenCalled()
    },
  )

  it("passes a price failure back as it is", async () => {
    const down = new UnknownPriceServiceError("price service offline")
    mockCentsPerSat.mockResolvedValue(down)

    expect(await usdCentsToDeliverSats(6_000)).toBe(down)
  })

  it.each([0, -0.06, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses to convert at a price of %p",
    async (price) => {
      mockCentsPerSat.mockResolvedValue(price)

      expect(await usdCentsToDeliverSats(6_000)).toBeInstanceOf(PriceNotAvailableError)
    },
  )

  it("refuses an amount whose dollar value is not a safe integer of cents", async () => {
    mockCentsPerSat.mockResolvedValue(1e9)

    expect(await usdCentsToDeliverSats(2 ** 52)).toBeInstanceOf(InvalidSendAmountError)
  })

  it("records what it converted, as strings, so the delivered amount can be checked later", async () => {
    await convert(6_000)

    expect(mockAddAttributes).toHaveBeenCalledWith({
      "onchainBtcDenominated.sats": "6000",
      "onchainBtcDenominated.centsPerSat": "0.06",
      "onchainBtcDenominated.marginBps": "50",
      "onchainBtcDenominated.cents": "362",
    })
  })
})
