import {
  computeEstimatedGasBufferUsd,
  fetchEthereumGasPriceGwei,
  fetchEthUsdPrice,
} from "@services/bridge/ethereum-gas-estimate"

describe("ethereum gas estimate", () => {
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
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ result: "0x4a817c800" }),
    } as Response)

    const gasPriceGwei = await fetchEthereumGasPriceGwei({
      rpcUrl: "https://example.invalid",
      timeoutMs: 1000,
    })

    expect(gasPriceGwei).toBe(20)
    fetchMock.mockRestore()
  })

  it("reads ETH/USD from CoinGecko", async () => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ ethereum: { usd: 2500.5 } }),
    } as Response)

    const ethUsd = await fetchEthUsdPrice({ timeoutMs: 1000 })
    expect(ethUsd).toBe(2500.5)
    fetchMock.mockRestore()
  })
})
