import {
  computeEstimatedGasBufferUsd,
  fetchEthereumGasPriceGwei,
  fetchEthereumGasPriceGweiAverage,
  fetchEthereumGasMarketSnapshot,
  fetchEthUsdPrice,
} from "@services/bridge/ethereum-gas-estimate"

describe("ethereum gas estimate", () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("computes buffered ERC-20 gas cost in USD", () => {
    expect(
      computeEstimatedGasBufferUsd({
        gasLimit: 65_000,
        gasPriceGwei: 20,
        ethUsd: 3000,
        bufferMultiplier: 1.5,
      }),
    ).toBe("5.85")
  })

  it("parses eth_gasPrice hex wei into gwei", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ result: "0x4a817c800" }),
    } as Response)

    const gasPriceGwei = await fetchEthereumGasPriceGwei({
      rpcUrl: "https://example.invalid",
      timeoutMs: 1000,
    })

    expect(gasPriceGwei).toBe(20)
  })

  it("averages gas price from multiple successful Ethereum RPC sources", async () => {
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: "0x4a817c800" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: "0x6fc23ac00" }),
      } as Response)

    const gasPriceGwei = await fetchEthereumGasPriceGweiAverage({
      rpcUrls: ["https://example-one.invalid", "https://example-two.invalid"],
      timeoutMs: 1000,
    })

    expect(gasPriceGwei).toBe(25)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("falls back only when all Ethereum RPC gas sources fail", async () => {
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 502,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ethereum: { usd: 2500 } }),
      } as Response)

    const snapshot = await fetchEthereumGasMarketSnapshot({
      rpcUrls: ["https://example-one.invalid", "https://example-two.invalid"],
      timeoutMs: 1000,
      fallbackGasPriceGwei: 30,
      ethUsdFallback: 3000,
    })

    expect(snapshot).toEqual({ gasPriceGwei: 30, ethUsd: 2500 })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it("caches gas market snapshots for the configured TTL and uses the configured ETH/USD URL", async () => {
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: "0x4a817c800" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ethereum: { usd: 2500 } }),
      } as Response)

    const args = {
      rpcUrls: ["https://cache-rpc.example.invalid"],
      timeoutMs: 1000,
      fallbackGasPriceGwei: 30,
      ethUsdFallback: 3000,
      ethUsdPriceUrl: "https://prices.example.invalid/eth-usd",
      cacheTtlMs: 60_000,
    }

    const first = await fetchEthereumGasMarketSnapshot(args)
    const second = await fetchEthereumGasMarketSnapshot(args)

    expect(first).toEqual({ gasPriceGwei: 20, ethUsd: 2500 })
    expect(second).toBe(first)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toBe("https://prices.example.invalid/eth-usd")
  })

  it("reads ETH/USD from CoinGecko", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ ethereum: { usd: 2500.5 } }),
    } as Response)

    const ethUsd = await fetchEthUsdPrice({ timeoutMs: 1000 })
    expect(ethUsd).toBe(2500.5)
  })
})
