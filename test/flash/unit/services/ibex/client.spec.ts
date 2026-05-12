const mockGetAccessToken = jest.fn()
const mockSetAccessToken = jest.fn()
const mockSetRefreshToken = jest.fn()

jest.mock("@config", () => ({
  IbexConfig: {
    url: "https://api-sandbox.poweredbyibex.io",
    authUrl: "https://auth.hub.sandbox.poweredbyibex.io",
    email: "test@example.com",
    password: "password",
    webhook: {
      uri: "https://example.com/webhook",
      port: 4008,
      secret: "secret",
    },
  },
}))

jest.mock("@services/tracing", () => ({
  addAttributesToCurrentSpan: jest.fn(),
  wrapAsyncFunctionsToRunInSpan: ({ fns }: { fns: unknown }) => fns,
}))

jest.mock("@services/logger", () => ({
  baseLogger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  },
}))

jest.mock("@services/ibex/webhook-server", () => ({
  __esModule: true,
  default: {
    endpoints: {
      onReceive: {
        onchain: "https://example.com/onchain",
        lnurl: "",
        invoice: "",
        cashout: "",
        zap: "",
      },
      onPay: { onchain: "https://example.com/onpay", lnurl: "", invoice: "" },
      cryptoReceive: "https://example.com/crypto-receive",
    },
    secret: "secret",
  },
}))

jest.mock("@services/ibex/cache", () => ({
  Redis: {
    get: jest.fn(),
    set: jest.fn(),
    delete: jest.fn(),
  },
}))

jest.mock("ibex-client", () =>
  jest.fn().mockImplementation(() => ({
    authentication: {
      storage: {
        getAccessToken: mockGetAccessToken,
        setAccessToken: mockSetAccessToken,
        setRefreshToken: mockSetRefreshToken,
      },
    },
  })),
)

let Ibex: typeof import("@services/ibex/client").default

describe("Ibex crypto receive info client", () => {
  const fetchMock = jest.fn()

  beforeAll(async () => {
    Ibex = (await import("@services/ibex/client")).default
  })

  beforeEach(() => {
    jest.clearAllMocks()
    global.fetch = fetchMock
  })

  it("sends the raw IBEX access token when fetching crypto receive options", async () => {
    mockGetAccessToken.mockResolvedValue("access-token")
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        options: [
          {
            id: "ethereum-usdt",
            name: "Ethereum USDT",
            currency: "USDT",
            network: "Ethereum",
          },
        ],
      }),
    })

    const option = await Ibex.getEthereumUsdtOption()

    expect(option).toMatchObject({ id: "ethereum-usdt" })
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api-sandbox.poweredbyibex.io/crypto/receive-infos/options",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "access-token",
        }),
      }),
    )
  })

  it("accepts common IBEX Ethereum USDT network labels", async () => {
    mockGetAccessToken.mockResolvedValue("access-token")
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        options: [
          {
            id: "tron-usdt",
            name: "Tron USDT",
            currency: "USDT",
            network: "Tron",
          },
          {
            id: "eth-usdt",
            name: "USDT ERC20",
            currency: "USDT",
            network: "ETH",
          },
        ],
      }),
    })

    const option = await Ibex.getEthereumUsdtOption()

    expect(option).toMatchObject({ id: "eth-usdt" })
  })

  it("returns available crypto receive options when Ethereum USDT is missing", async () => {
    mockGetAccessToken.mockResolvedValue("access-token")
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        options: [
          {
            id: "tron-usdt",
            name: "Tron USDT",
            currency: "USDT",
            network: "Tron",
          },
        ],
      }),
    })

    const option = await Ibex.getEthereumUsdtOption()

    expect(option).toBeInstanceOf(Error)
    expect((option as Error).message).toContain("Available options")
    expect((option as Error).message).toContain("Tron")
  })
})
