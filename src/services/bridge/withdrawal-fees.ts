/**
 * Bridge withdrawal customer fee estimates.
 *
 * estimatedCustomerFee = flashFee + estimatedBridgeFee + estimatedGasBuffer
 * flashFee = amount * developerFeePercent (Flash fee passed to Bridge)
 * estimatedBridgeFee = amount * bridgeFixedFeePercent (0.60% for USDT ETH -> USD ACH)
 * estimatedGasBuffer = gasLimit * gasPriceGwei * ethUsd / 1e9 * bufferMultiplier
 */

import { BridgeConfig } from "@config"

import {
  computeEstimatedGasBufferUsd,
  fetchEthereumGasMarketSnapshot,
  type EthereumGasMarketSnapshot,
} from "./ethereum-gas-estimate"

export type BridgeWithdrawalFeeEstimateConfig = {
  bridgeFixedFeePercent: number
  usdtTransferGasLimit: number
  gasPriceBufferMultiplier: number
  ethereumGasRpcUrls: string[]
  fallbackGasPriceGwei: number
  ethUsdFallback: number
}

export type CustomerFeeEstimate = {
  estimatedBridgeFeePercent: string
  estimatedBridgeFee: string
  estimatedGasBuffer: string
  estimatedCustomerFee: string
  flashFeePercent: string
  flashFee: string
}

export const defaultWithdrawalFeeEstimateConfig =
  (): BridgeWithdrawalFeeEstimateConfig => ({
    bridgeFixedFeePercent: 0.6,
    usdtTransferGasLimit: 65_000,
    gasPriceBufferMultiplier: 1.5,
    ethereumGasRpcUrls: [
      "https://ethereum-rpc.publicnode.com",
      "https://eth.llamarpc.com",
      "https://cloudflare-eth.com",
    ],
    fallbackGasPriceGwei: 30,
    ethUsdFallback: 3000,
  })

export const getWithdrawalFeeEstimateConfig = (): BridgeWithdrawalFeeEstimateConfig => ({
  ...defaultWithdrawalFeeEstimateConfig(),
  ...BridgeConfig.withdrawalFeeEstimate,
})

export const computeCustomerFeeEstimateFromGasMarket = ({
  amount,
  gasMarket,
  config = getWithdrawalFeeEstimateConfig(),
  developerFeePercent = BridgeConfig.developerFeePercent,
}: {
  amount: string
  gasMarket: EthereumGasMarketSnapshot
  config?: BridgeWithdrawalFeeEstimateConfig
  developerFeePercent?: number
}): CustomerFeeEstimate => {
  const flashFee = ((parseFloat(amount) * developerFeePercent) / 100).toFixed(2)
  const estimatedBridgeFee = (
    (parseFloat(amount) * config.bridgeFixedFeePercent) /
    100
  ).toFixed(2)
  const estimatedGasBuffer = computeEstimatedGasBufferUsd({
    gasLimit: config.usdtTransferGasLimit,
    gasPriceGwei: gasMarket.gasPriceGwei,
    ethUsd: gasMarket.ethUsd,
    bufferMultiplier: config.gasPriceBufferMultiplier,
  })
  const estimatedCustomerFee = (
    parseFloat(flashFee) +
    parseFloat(estimatedBridgeFee) +
    parseFloat(estimatedGasBuffer)
  ).toFixed(2)

  return {
    estimatedBridgeFeePercent: String(config.bridgeFixedFeePercent),
    estimatedBridgeFee,
    estimatedGasBuffer,
    estimatedCustomerFee,
    flashFeePercent: String(developerFeePercent),
    flashFee,
  }
}

export const resolveWithdrawalCustomerFeeEstimate = async (
  amount: string,
): Promise<CustomerFeeEstimate> => {
  const config = getWithdrawalFeeEstimateConfig()
  const gasMarket = await fetchEthereumGasMarketSnapshot({
    rpcUrls: config.ethereumGasRpcUrls,
    timeoutMs: BridgeConfig.timeoutMs ?? 10_000,
    fallbackGasPriceGwei: config.fallbackGasPriceGwei,
    ethUsdFallback: config.ethUsdFallback,
  })

  return computeCustomerFeeEstimateFromGasMarket({ amount, gasMarket, config })
}

export const computePendingAmountEstimates = (
  amount: string,
  estimatedCustomerFee: string,
): { subtotalAmount: string; finalAmount: string } => {
  const subtotal = Math.max(0, parseFloat(amount) - parseFloat(estimatedCustomerFee))
  const formatted = subtotal.toFixed(2)
  return { subtotalAmount: formatted, finalAmount: formatted }
}

export type BridgeWithdrawalReceiptFees = {
  bridgeDeveloperFee?: string
  bridgeExchangeFee?: string
  subtotalAmount?: string
  finalAmount?: string
}

export type BridgeWithdrawalLike = {
  id?: string
  amount: string
  currency: string
  externalAccountId: string
  status: string
  flashFeePercent?: string
  flashFee?: string
  estimatedBridgeFeePercent?: string
  estimatedBridgeFee?: string
  estimatedGasBuffer?: string
  estimatedCustomerFee?: string
  bridgeDeveloperFee?: string
  bridgeExchangeFee?: string
  subtotalAmount?: string
  finalAmount?: string
  bridgeTransferId?: string | null
  failureReason?: string
  createdAt: Date | string
}

export const isFlashFeeEstimate = (
  withdrawal: Pick<BridgeWithdrawalLike, "bridgeDeveloperFee">,
): boolean => !withdrawal.bridgeDeveloperFee

export const receiptFeesFromTransfer = (receipt?: {
  developer_fee?: string
  exchange_fee?: string
  subtotal_amount?: string
  final_amount?: string
}): BridgeWithdrawalReceiptFees => ({
  bridgeDeveloperFee:
    receipt?.developer_fee != null ? String(receipt.developer_fee) : undefined,
  bridgeExchangeFee:
    receipt?.exchange_fee != null ? String(receipt.exchange_fee) : undefined,
  subtotalAmount:
    receipt?.subtotal_amount != null ? String(receipt.subtotal_amount) : undefined,
  finalAmount: receipt?.final_amount != null ? String(receipt.final_amount) : undefined,
})

const withdrawalId = (withdrawal: BridgeWithdrawalLike): string => {
  if (withdrawal.id) return withdrawal.id
  const mongoId = (withdrawal as { _id?: { toString(): string } })._id
  return mongoId ? mongoId.toString() : ""
}

type MaybeMongooseWithdrawal = BridgeWithdrawalLike & {
  toObject?: (options?: { virtuals?: boolean }) => Record<string, unknown>
}

/** Mongoose documents do not spread their schema fields; normalize before merging. */
export const toBridgeWithdrawalLike = (
  withdrawal: MaybeMongooseWithdrawal,
): BridgeWithdrawalLike => {
  if (typeof withdrawal.toObject !== "function") return withdrawal

  const plain = withdrawal.toObject({ virtuals: true }) as BridgeWithdrawalLike
  return {
    ...plain,
    id: withdrawalId(plain),
  }
}

const estimatedCustomerFeeFor = (
  withdrawal: BridgeWithdrawalLike,
): string | undefined => {
  if (withdrawal.estimatedCustomerFee) return withdrawal.estimatedCustomerFee
  if (
    withdrawal.flashFee != null &&
    withdrawal.estimatedBridgeFee != null &&
    withdrawal.estimatedGasBuffer != null
  ) {
    return (
      parseFloat(withdrawal.flashFee) +
      parseFloat(withdrawal.estimatedBridgeFee) +
      parseFloat(withdrawal.estimatedGasBuffer)
    ).toFixed(2)
  }
  return undefined
}

const resolveAmounts = (
  withdrawal: BridgeWithdrawalLike,
  flashFeeIsEstimate: boolean,
) => {
  if (withdrawal.subtotalAmount && withdrawal.finalAmount) {
    return {
      subtotalAmount: withdrawal.subtotalAmount,
      finalAmount: withdrawal.finalAmount,
    }
  }

  const estimatedCustomerFee = estimatedCustomerFeeFor(withdrawal)
  if (flashFeeIsEstimate && estimatedCustomerFee) {
    return computePendingAmountEstimates(withdrawal.amount, estimatedCustomerFee)
  }

  return {
    subtotalAmount: withdrawal.subtotalAmount,
    finalAmount: withdrawal.finalAmount,
  }
}

const withFeeEstimate = (
  withdrawal: BridgeWithdrawalLike,
  feeEstimate?: CustomerFeeEstimate,
): BridgeWithdrawalLike => {
  const plain = toBridgeWithdrawalLike(withdrawal)
  if (!feeEstimate) return plain

  return {
    ...plain,
    flashFeePercent: feeEstimate.flashFeePercent,
    flashFee: feeEstimate.flashFee,
    estimatedBridgeFeePercent: feeEstimate.estimatedBridgeFeePercent,
    estimatedBridgeFee: feeEstimate.estimatedBridgeFee,
    estimatedGasBuffer: feeEstimate.estimatedGasBuffer,
    estimatedCustomerFee: feeEstimate.estimatedCustomerFee,
  }
}

export const presentBridgeWithdrawal = (
  withdrawal: BridgeWithdrawalLike,
  feeEstimate?: CustomerFeeEstimate,
) => {
  const source = withFeeEstimate(withdrawal, feeEstimate)
  const createdAt =
    source.createdAt instanceof Date ? source.createdAt.toISOString() : source.createdAt
  const flashFeeIsEstimate = isFlashFeeEstimate(source)
  const { subtotalAmount, finalAmount } = resolveAmounts(source, flashFeeIsEstimate)
  const estimatedCustomerFee = estimatedCustomerFeeFor(source)

  return {
    id: withdrawalId(source),
    amount: source.amount,
    currency: source.currency,
    externalAccountId: source.externalAccountId,
    status: source.status,
    estimatedBridgeFeePercent: source.estimatedBridgeFeePercent,
    estimatedBridgeFee: source.estimatedBridgeFee,
    estimatedGasBuffer: source.estimatedGasBuffer,
    estimatedCustomerFee,
    flashFeePercent: source.flashFeePercent,
    flashFee: source.flashFee,
    flashFeeIsEstimate,
    bridgeDeveloperFee: source.bridgeDeveloperFee,
    bridgeExchangeFee: source.bridgeExchangeFee,
    subtotalAmount,
    finalAmount,
    bridgeTransferId: source.bridgeTransferId ?? undefined,
    failureReason: source.failureReason,
    createdAt,
  }
}

export type PresentedBridgeWithdrawal = ReturnType<typeof presentBridgeWithdrawal>
