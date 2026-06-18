import { baseLogger } from "@services/logger"

export type EthereumGasMarketSnapshot = {
  gasPriceGwei: number
  ethUsd: number
}

const DEFAULT_ETH_USD_PRICE_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd"

type CachedGasMarketSnapshot = {
  key: string
  expiresAt: number
  snapshot: EthereumGasMarketSnapshot
}

let cachedGasMarketSnapshot: CachedGasMarketSnapshot | undefined

export const computeEstimatedGasBufferUsd = ({
  gasLimit,
  gasPriceGwei,
  ethUsd,
  bufferMultiplier,
}: {
  gasLimit: number
  gasPriceGwei: number
  ethUsd: number
  bufferMultiplier: number
}): string => {
  const gasUsd = ((gasLimit * gasPriceGwei * ethUsd) / 1e9) * bufferMultiplier
  return gasUsd.toFixed(2)
}

const parseHexWeiToGwei = (hexWei: string): number | Error => {
  const normalized = hexWei.startsWith("0x") ? hexWei.slice(2) : hexWei
  if (!/^[0-9a-fA-F]+$/.test(normalized)) {
    return new Error(`Invalid gas price response: ${hexWei}`)
  }
  const wei = BigInt(`0x${normalized}`)
  return Number(wei) / 1e9
}

export const fetchEthereumGasPriceGwei = async ({
  rpcUrl,
  timeoutMs,
}: {
  rpcUrl: string
  timeoutMs: number
}): Promise<number | Error> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_gasPrice",
        params: [],
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      return new Error(`Ethereum RPC gas price request failed: HTTP ${response.status}`)
    }

    const payload = (await response.json()) as {
      result?: string
      error?: { message?: string }
    }

    if (payload.error?.message) {
      return new Error(`Ethereum RPC gas price error: ${payload.error.message}`)
    }
    if (!payload.result) {
      return new Error("Ethereum RPC gas price response missing result")
    }

    const gasPriceGwei = parseHexWeiToGwei(payload.result)
    if (gasPriceGwei instanceof Error) return gasPriceGwei
    if (!Number.isFinite(gasPriceGwei) || gasPriceGwei <= 0) {
      return new Error(`Invalid gas price gwei value: ${gasPriceGwei}`)
    }

    return gasPriceGwei
  } catch (error) {
    baseLogger.warn({ error, rpcUrl }, "Failed to fetch Ethereum gas price")
    return error instanceof Error ? error : new Error(String(error))
  } finally {
    clearTimeout(timeout)
  }
}

export const fetchEthereumGasPriceGweiAverage = async ({
  rpcUrls,
  timeoutMs,
}: {
  rpcUrls: string[]
  timeoutMs: number
}): Promise<number | Error> => {
  if (rpcUrls.length === 0) {
    return new Error("No Ethereum RPC URLs configured for gas price estimate")
  }

  const gasPriceResults = await Promise.all(
    rpcUrls.map((rpcUrl) => fetchEthereumGasPriceGwei({ rpcUrl, timeoutMs })),
  )
  const gasPrices = gasPriceResults.filter(
    (result): result is number => !(result instanceof Error),
  )

  if (gasPrices.length === 0) {
    return new Error("All Ethereum RPC gas price requests failed")
  }

  return gasPrices.reduce((sum, gasPrice) => sum + gasPrice, 0) / gasPrices.length
}

export const fetchEthUsdPrice = async ({
  url = DEFAULT_ETH_USD_PRICE_URL,
  timeoutMs,
}: {
  url?: string
  timeoutMs: number
}): Promise<number | Error> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) {
      return new Error(`ETH/USD price request failed: HTTP ${response.status}`)
    }

    const payload = (await response.json()) as { ethereum?: { usd?: number } }
    const ethUsd = payload.ethereum?.usd
    if (ethUsd == null || !Number.isFinite(ethUsd) || ethUsd <= 0) {
      return new Error("ETH/USD price response missing ethereum.usd")
    }

    return ethUsd
  } catch (error) {
    baseLogger.warn({ error, url }, "Failed to fetch ETH/USD price")
    return error instanceof Error ? error : new Error(String(error))
  } finally {
    clearTimeout(timeout)
  }
}

export const fetchEthereumGasMarketSnapshot = async ({
  rpcUrls,
  timeoutMs,
  fallbackGasPriceGwei,
  ethUsdFallback,
  ethUsdPriceUrl = DEFAULT_ETH_USD_PRICE_URL,
  cacheTtlMs = 0,
}: {
  rpcUrls: string[]
  timeoutMs: number
  fallbackGasPriceGwei: number
  ethUsdFallback: number
  ethUsdPriceUrl?: string
  cacheTtlMs?: number
}): Promise<EthereumGasMarketSnapshot> => {
  const cacheKey = JSON.stringify({
    rpcUrls,
    timeoutMs,
    fallbackGasPriceGwei,
    ethUsdFallback,
    ethUsdPriceUrl,
  })
  const now = Date.now()
  if (
    cacheTtlMs > 0 &&
    cachedGasMarketSnapshot?.key === cacheKey &&
    cachedGasMarketSnapshot.expiresAt > now
  ) {
    return cachedGasMarketSnapshot.snapshot
  }

  const [gasPriceResult, ethUsdResult] = await Promise.all([
    fetchEthereumGasPriceGweiAverage({ rpcUrls, timeoutMs }),
    fetchEthUsdPrice({ url: ethUsdPriceUrl, timeoutMs }),
  ])

  const gasPriceGwei =
    gasPriceResult instanceof Error ? fallbackGasPriceGwei : gasPriceResult
  const ethUsd = ethUsdResult instanceof Error ? ethUsdFallback : ethUsdResult

  if (gasPriceResult instanceof Error) {
    baseLogger.warn(
      { fallbackGasPriceGwei, error: gasPriceResult.message },
      "Using fallback Ethereum gas price for withdrawal fee estimate",
    )
  }
  if (ethUsdResult instanceof Error) {
    baseLogger.warn(
      { ethUsdFallback, error: ethUsdResult.message },
      "Using fallback ETH/USD price for withdrawal fee estimate",
    )
  }

  const snapshot = { gasPriceGwei, ethUsd }
  if (cacheTtlMs > 0) {
    cachedGasMarketSnapshot = {
      key: cacheKey,
      expiresAt: now + cacheTtlMs,
      snapshot,
    }
  }

  return snapshot
}
