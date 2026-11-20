// ENG-891: getTransactionNetworkId produces the on-chain tx hash that the
// deposit matcher joins Bridge deposits to IBEX credits on.
const mockGetAccessToken = jest.fn()
const mockSetAccessToken = jest.fn()
const mockFetch = jest.fn()

global.fetch = mockFetch as unknown as typeof fetch

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
          getAccessToken: (...args: unknown[]) => mockGetAccessToken(...args),
          setAccessToken: (...args: unknown[]) => mockSetAccessToken(...args),
          setRefreshToken: jest.fn(),
        },
      },
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

import Ibex from "@services/ibex/client"
import { IbexError } from "@services/ibex/errors"

const respondWith = (body: unknown) =>
  mockFetch.mockResolvedValue({ ok: true, json: async () => body })

describe("Ibex.getTransactionNetworkId", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFetch.mockReset()
    mockGetAccessToken.mockResolvedValue("Bearer test-token")
    mockSetAccessToken.mockResolvedValue(undefined)
  })

  it("returns the networkId from the transaction details", async () => {
    respondWith({ id: "ibex-tx-1", networkId: "0xabc" })

    expect(await Ibex.getTransactionNetworkId("ibex-tx-1")).toBe("0xabc")
  })

  it("returns undefined when networkId is null", async () => {
    respondWith({ id: "ibex-tx-1", networkId: null })

    expect(await Ibex.getTransactionNetworkId("ibex-tx-1")).toBeUndefined()
  })

  it("returns undefined when networkId is empty", async () => {
    respondWith({ id: "ibex-tx-1", networkId: "" })

    expect(await Ibex.getTransactionNetworkId("ibex-tx-1")).toBeUndefined()
  })

  it("returns undefined when networkId is missing", async () => {
    respondWith({ id: "ibex-tx-1" })

    expect(await Ibex.getTransactionNetworkId("ibex-tx-1")).toBeUndefined()
  })

  it("returns an IbexError on a non-2xx response", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "unavailable",
    })

    const result = await Ibex.getTransactionNetworkId("ibex-tx-1")

    expect(result).toBeInstanceOf(IbexError)
  })

  it("returns an IbexError when the token request fails", async () => {
    mockGetAccessToken.mockResolvedValue(undefined)
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "unauthorized",
    })

    const result = await Ibex.getTransactionNetworkId("ibex-tx-1")

    expect(result).toBeInstanceOf(IbexError)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch).toHaveBeenCalledWith(
      "https://auth.sandbox.example/oauth/token",
      expect.anything(),
    )
  })

  it("requests the v2 details path with the id URL-encoded", async () => {
    respondWith({ networkId: "0xabc" })

    await Ibex.getTransactionNetworkId("tx/1 a?b")

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.sandbox.example/v2/transaction/tx%2F1%20a%3Fb/details",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer test-token" }),
      }),
    )
  })
})
