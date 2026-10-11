const mockEstimateOnchainFee = jest.fn()

jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: {
    estimateOnchainFee: (...args: unknown[]) => mockEstimateOnchainFee(...args),
  },
}))

jest.mock("@services/ibex/errors", () => ({
  IbexError: class IbexError extends Error {},
}))

import { USDAmount } from "@domain/shared"
import { IbexError } from "@services/ibex/errors"

import { getSendAllOnChainAmount } from "@app/wallets/get-send-all-onchain-amount"

const address = "bc1qexampleaddress" as OnChainAddress

// #270: IBEX charges its on-chain fee on top of the amount it forwards, so a
// sendAll sweep has to hand over `balance - fee` rather than the whole balance.
describe("getSendAllOnChainAmount", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("subtracts the estimated fee from the balance", async () => {
    mockEstimateOnchainFee.mockResolvedValue({ fee: 0.01 })

    const amount = USDAmount.cents("1000") as USDAmount
    const result = await getSendAllOnChainAmount({
      amount,
      address,
    })

    expect(mockEstimateOnchainFee).toHaveBeenCalledWith(amount, address)
    expect(result).toBeInstanceOf(USDAmount)
    expect((result as USDAmount).asCents()).toBe("999")
  })

  it("keeps fractional cents of the estimate instead of flooring them", async () => {
    mockEstimateOnchainFee.mockResolvedValue({ fee: 0.004 })

    const result = await getSendAllOnChainAmount({
      amount: USDAmount.cents("1000") as USDAmount,
      address,
    })

    expect((result as USDAmount).asCents(2)).toBe("999.60")
  })

  it("keeps the full balance when the estimate call fails", async () => {
    mockEstimateOnchainFee.mockResolvedValue(new IbexError(new Error("ibex down")))

    const result = await getSendAllOnChainAmount({
      amount: USDAmount.cents("1000") as USDAmount,
      address,
    })

    expect((result as USDAmount).asCents()).toBe("1000")
  })

  it.each([
    ["missing", undefined],
    ["zero", 0],
    ["not a number", "abc"],
  ])("keeps the full balance when the fee is %s", async (_label, fee) => {
    mockEstimateOnchainFee.mockResolvedValue({ fee })

    const result = await getSendAllOnChainAmount({
      amount: USDAmount.cents("1000") as USDAmount,
      address,
    })

    expect((result as USDAmount).asCents()).toBe("1000")
  })

  // A fee that covers the whole balance leaves nothing sendable: `balance - fee`
  // would be zero or negative, which the rail refuses anyway.
  it("keeps the full balance when the fee covers it", async () => {
    mockEstimateOnchainFee.mockResolvedValue({ fee: 10 })

    const result = await getSendAllOnChainAmount({
      amount: USDAmount.cents("100") as USDAmount,
      address,
    })

    expect((result as USDAmount).asCents()).toBe("100")
  })
})
