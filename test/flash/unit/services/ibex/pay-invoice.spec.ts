const mockPayInvoiceV2 = jest.fn()
const mockGetAccessToken = jest.fn()
const mockSetAccessToken = jest.fn()

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

// Keep the REAL ibex-client error classes (errorHandler relies on instanceof
// against them); mock only the client instance so we can drive the SDK call
// underneath payInvoice. The mocked payInvoiceV2 mirrors ibex-client v3.3.0's
// wrapper contract, which the collapsed payInvoice path
// (`Ibex.payInvoiceV2(body).then(errorHandler)`, lnflash/flash#478) relies on:
// `withAuth` unwraps `.data` on success or resolves with an
// AuthenticationError, and anything thrown resolves as `new ApiError(thrown)`.
jest.mock("ibex-client", () => {
  const actual = jest.requireActual("ibex-client")
  return {
    ...actual,
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      authentication: {
        storage: {
          getAccessToken: (...args: unknown[]) => mockGetAccessToken(...args),
          setAccessToken: (...args: unknown[]) => mockSetAccessToken(...args),
          setRefreshToken: jest.fn(),
        },
      },
      payInvoiceV2: async (body: unknown) => {
        try {
          const resp = await mockPayInvoiceV2(body)
          if (resp instanceof actual.AuthenticationError) return resp
          return (resp as { data: unknown }).data
        } catch (err) {
          return new actual.ApiError(err as Error)
        }
      },
    })),
  }
})

import { ErrorLevel } from "@domain/shared"
import { AuthenticationError } from "ibex-client"

import Ibex from "@services/ibex/client"
import { IbexError, InsufficientIbexBalance } from "@services/ibex/errors"

const insufficientDetail =
  "insufficient balance. Current Balance: 5.000000. Estimated Fee: 0.001109. invoice amount: 5.042164. account: 39c6e986-979b-40ab-9e7b-df18a9277a84"

const fetchErrorShaped = (status: number, data: unknown): Error => {
  const err = new Error("Bad Request") as Error & { status: number; data: unknown }
  err.name = "FetchError"
  err.status = status
  err.data = data
  return err
}

describe("Ibex.payInvoice error classification", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  const payArgs = {
    invoice: "lnbc1" as Bolt11,
    accountId: "wallet-1" as IbexAccountId,
  }

  it("returns InsufficientIbexBalance for a 400 with an insufficient-balance body", async () => {
    mockPayInvoiceV2.mockRejectedValue(
      fetchErrorShaped(400, { error: insufficientDetail }),
    )

    const result = await Ibex.payInvoice(payArgs)

    expect(result).toBeInstanceOf(InsufficientIbexBalance)
    const err = result as InsufficientIbexBalance
    expect(err.httpCode).toBe(400)
    // client-facing message strips IBEX's trailing internal account UUID
    expect(err.message).toBe(
      "insufficient balance. Current Balance: 5.000000. Estimated Fee: 0.001109. invoice amount: 5.042164",
    )
    expect(err.message).not.toContain("account:")
    // the unstripped vendor text is preserved for logs/spans
    expect(err.detail).toBe(insufficientDetail)
  })

  it("returns a generic IbexError for other 400s", async () => {
    mockPayInvoiceV2.mockRejectedValue(
      fetchErrorShaped(400, { error: "invalid parameters" }),
    )

    const result = await Ibex.payInvoice(payArgs)

    expect(result).toBeInstanceOf(IbexError)
    expect(result).not.toBeInstanceOf(InsufficientIbexBalance)
    expect((result as IbexError).httpCode).toBe(400)
  })

  it("returns a generic IbexError for network-level failures", async () => {
    mockPayInvoiceV2.mockRejectedValue(new TypeError("fetch failed"))

    const result = await Ibex.payInvoice(payArgs)

    expect(result).toBeInstanceOf(IbexError)
    expect(result).not.toBeInstanceOf(InsufficientIbexBalance)
    expect((result as IbexError).httpCode).toBeUndefined()
  })

  it("returns a critical IbexError when authentication fails", async () => {
    // withAuth resolves with (never throws) an AuthenticationError
    mockPayInvoiceV2.mockResolvedValue(new AuthenticationError("auth failed"))

    const result = await Ibex.payInvoice(payArgs)

    expect(result).toBeInstanceOf(IbexError)
    expect(result).not.toBeInstanceOf(InsufficientIbexBalance)
    expect((result as IbexError).level).toBe(ErrorLevel.Critical)
  })

  it("passes successful payments through with the webhook body", async () => {
    const response = {
      transaction: { payment: { status: { id: 2 } } },
    }
    mockPayInvoiceV2.mockResolvedValue({ data: response, status: 200 })

    const result = await Ibex.payInvoice(payArgs)

    expect(result).toBe(response)
    expect(mockPayInvoiceV2).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "wallet-1",
        bolt11: "lnbc1",
        webhookUrl: expect.stringContaining("/pay/invoice"),
      }),
    )
  })
})
