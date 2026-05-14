const mockAddInvoice = jest.fn()
const mockGetFeeEstimation = jest.fn()
const mockEstimateFeeV2 = jest.fn()

jest.mock("@services/ibex/cache", () => ({
  Redis: {
    get: jest.fn(),
    set: jest.fn(),
    delete: jest.fn(),
  },
}))

jest.mock("ibex-client", () => {
  class AuthenticationError extends Error {}
  class ApiError extends Error {}
  class UnexpectedResponseError extends Error {}
  class IbexClientError extends Error {}

  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      authentication: {
        storage: {
          getAccessToken: jest.fn(),
          setAccessToken: jest.fn(),
          setRefreshToken: jest.fn(),
        },
      },
      addInvoice: (...args: unknown[]) => mockAddInvoice(...args),
      getFeeEstimation: (...args: unknown[]) => mockGetFeeEstimation(...args),
      estimateFeeV2: (...args: unknown[]) => mockEstimateFeeV2(...args),
    })),
    AuthenticationError,
    ApiError,
    UnexpectedResponseError,
    IbexClientError,
  }
})

import { USDAmount, USDTAmount, WalletCurrency } from "@domain/shared"
import Ibex from "@services/ibex/client"

describe("IBEX USD wallet amount handling", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("creates USDT invoices using decimal USDT amount", async () => {
    const amount = USDTAmount.smallestUnits("19446") as USDTAmount
    mockAddInvoice.mockResolvedValue({ invoice: { bolt11: "lnbc1" } })

    await Ibex.addInvoice({
      accountId: "ibex-usdt-account" as IbexAccountId,
      amount,
      memo: "usdt invoice",
    })

    expect(mockAddInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "ibex-usdt-account",
        amount: 0.019446,
      }),
    )
  })

  it("estimates LN fees with USDT currency id and parses USDT amounts", async () => {
    const amount = USDTAmount.smallestUnits("19446") as USDTAmount
    mockGetFeeEstimation.mockResolvedValue({ amount: 0.000123, invoiceAmount: 0.019446 })

    const result = await Ibex.getLnFeeEstimation({
      invoice: "lnbc1" as Bolt11,
      send: amount,
    })

    expect(mockGetFeeEstimation).toHaveBeenCalledWith({
      bolt11: "lnbc1",
      amount: "0.019446",
      currencyId: "29",
    })
    expect(result).not.toBeInstanceOf(Error)
    expect((result as { fee: USDTAmount }).fee).toBeInstanceOf(USDTAmount)
    expect((result as { fee: USDTAmount }).fee.asSmallestUnits()).toBe("123")
    expect((result as { invoice: USDTAmount }).invoice.asSmallestUnits()).toBe("19446")
  })

  it("estimates fixed-amount LN fees with USDT currency id when no send amount is provided", async () => {
    mockGetFeeEstimation.mockResolvedValue({ amount: 0.000123, invoiceAmount: 0.019446 })

    const result = await Ibex.getLnFeeEstimation({
      invoice: "lnbc1" as Bolt11,
      currency: WalletCurrency.Usdt,
    })

    expect(mockGetFeeEstimation).toHaveBeenCalledWith({
      bolt11: "lnbc1",
      amount: undefined,
      currencyId: "29",
    })
    expect(result).not.toBeInstanceOf(Error)
    expect((result as { fee: USDTAmount }).fee).toBeInstanceOf(USDTAmount)
    expect((result as { fee: USDTAmount }).fee.asSmallestUnits()).toBe("123")
  })

  it("keeps USD LN fee estimation behavior unchanged", async () => {
    const amount = USDAmount.cents("19446") as USDAmount
    mockGetFeeEstimation.mockResolvedValue({ amount: 0.12, invoiceAmount: 194.46 })

    const result = await Ibex.getLnFeeEstimation({
      invoice: "lnbc1" as Bolt11,
      send: amount,
    })

    expect(mockGetFeeEstimation).toHaveBeenCalledWith({
      bolt11: "lnbc1",
      amount: "194.46",
      currencyId: "3",
    })
    expect(result).not.toBeInstanceOf(Error)
    expect((result as { fee: USDAmount }).fee).toBeInstanceOf(USDAmount)
    expect((result as { fee: USDAmount }).fee.asCents()).toBe("12")
  })

  it("estimates on-chain fees with USDT currency id", async () => {
    const amount = USDTAmount.smallestUnits("19446") as USDTAmount
    mockEstimateFeeV2.mockResolvedValue({ fee: 0.000123 })

    await Ibex.estimateOnchainFee(amount, "0xabc" as OnChainAddress)

    expect(mockEstimateFeeV2).toHaveBeenCalledWith({
      "amount": 0.019446,
      "currency-id": "29",
      "address": "0xabc",
    })
  })
})
