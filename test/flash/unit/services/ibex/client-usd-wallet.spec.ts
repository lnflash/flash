const mockAddInvoice = jest.fn()
const mockGetFeeEstimation = jest.fn()
const mockEstimateFeeV2 = jest.fn()
const mockGetCryptoSendRequirements = jest.fn()
const mockCreateCryptoSendInfo = jest.fn()
const mockSendCrypto = jest.fn()

jest.mock("@services/ibex/cache", () => ({
  Redis: {
    get: jest.fn(),
    set: jest.fn(),
    delete: jest.fn(),
  },
}))

jest.mock("@services/ibex/webhook-server", () => ({
  __esModule: true,
  default: {
    endpoints: {
      onReceive: {
        invoice: "https://flash.test/ibex/receive/invoice",
        lnurl: "https://flash.test/ibex/receive/lnurl",
        onchain: "https://flash.test/ibex/receive/onchain",
      },
      onPay: {
        invoice: "https://flash.test/ibex/pay/invoice",
        lnurl: "https://flash.test/ibex/pay/lnurl",
        onchain: "https://flash.test/ibex/pay/onchain",
      },
    },
    secret: "test-secret",
  },
}))

jest.mock("ibex-client", () => {
  class AuthenticationError extends Error {}
  class ApiError extends Error {}
  class UnexpectedResponseError extends Error {}
  class IbexClientError extends Error {}

  return {
    ...jest.requireActual("ibex-client"),
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
      getCryptoSendRequirements: (...args: unknown[]) =>
        mockGetCryptoSendRequirements(...args),
      createCryptoSendInfo: (...args: unknown[]) => mockCreateCryptoSendInfo(...args),
      sendCrypto: (...args: unknown[]) => mockSendCrypto(...args),
    })),
    AuthenticationError,
    ApiError,
    UnexpectedResponseError,
    IbexClientError,
    IbexUrls: {
      sandbox: {
        authDomain: "https://auth.sandbox.example",
        audience: "https://api.sandbox.example",
        hubUrl: "https://api.sandbox.example",
      },
    },
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

  it("forwards crypto sends to the IBEX crypto send endpoint", async () => {
    mockSendCrypto.mockResolvedValue({
      transaction: { id: "ibex-payout-001", status: "PENDING" },
      cryptoTransaction: { networkTxId: "0xtx" },
    })

    await Ibex.sendCrypto({
      accountId: "ibex-usdt-account",
      cryptoSendInfosId: "send-info-001",
      amount: 2.5,
    })

    expect(mockSendCrypto).toHaveBeenCalledWith({
      accountId: "ibex-usdt-account",
      cryptoSendInfosId: "send-info-001",
      amount: 2.5,
    })
  })

  it("fetches crypto send requirements", async () => {
    mockGetCryptoSendRequirements.mockResolvedValue({
      requirementsId: "requirements-001",
      data: { address: { required: true } },
    })

    await Ibex.getCryptoSendRequirements({
      network: "ethereum",
      currencyId: USDTAmount.currencyId,
    })

    expect(mockGetCryptoSendRequirements).toHaveBeenCalledWith({
      network: "ethereum",
      currencyId: USDTAmount.currencyId,
    })
  })

  it("creates crypto send info", async () => {
    mockCreateCryptoSendInfo.mockResolvedValue({
      id: "send-info-001",
      name: "bridge-withdrawal-001",
      data: { address: "0xbridge" },
    })

    await Ibex.createCryptoSendInfo({
      name: "bridge-withdrawal-001",
      requirementsId: "requirements-001",
      data: { address: "0xbridge" },
    })

    expect(mockCreateCryptoSendInfo).toHaveBeenCalledWith({
      name: "bridge-withdrawal-001",
      requirementsId: "requirements-001",
      data: { address: "0xbridge" },
    })
  })
})
