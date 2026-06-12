jest.mock("@config", () => ({
  BridgeConfig: {
    developerFeePercent: 2,
    timeoutMs: 10_000,
    withdrawalFeeEstimate: {
      bridgeFixedFeePercent: 0.6,
      usdtTransferGasLimit: 65_000,
      gasPriceBufferMultiplier: 1.5,
      ethereumGasRpcUrl: "https://cloudflare-eth.com",
      fallbackGasPriceGwei: 30,
      ethUsdFallback: 3000,
    },
  },
}))

import {
  computeCustomerFeeEstimateFromGasMarket,
  computePendingAmountEstimates,
  presentBridgeWithdrawal,
  receiptFeesFromTransfer,
} from "@services/bridge/withdrawal-fees"

const feeConfig = {
  bridgeFixedFeePercent: 0.6,
  usdtTransferGasLimit: 65_000,
  gasPriceBufferMultiplier: 1.5,
  ethereumGasRpcUrl: "https://cloudflare-eth.com",
  fallbackGasPriceGwei: 30,
  ethUsdFallback: 3000,
}

describe("bridge withdrawal fees", () => {
  it("computes customer fee as flash fee + bridge fee + buffered gas", () => {
    const estimate = computeCustomerFeeEstimateFromGasMarket({
      amount: "50.00",
      gasMarket: { gasPriceGwei: 20, ethUsd: 3000 },
      config: feeConfig,
      developerFeePercent: 2,
    })

    expect(estimate.flashFeePercent).toBe("2")
    expect(estimate.flashFee).toBe("1.00")
    expect(estimate.estimatedBridgeFeePercent).toBe("0.6")
    expect(estimate.estimatedBridgeFee).toBe("0.30")
    expect(estimate.estimatedGasBuffer).toBe("5.85")
    expect(estimate.estimatedCustomerFee).toBe("7.15")
  })

  it("computes pending subtotal and final amount from estimated customer fee", () => {
    expect(computePendingAmountEstimates("50.00", "7.15")).toEqual({
      subtotalAmount: "42.85",
      finalAmount: "42.85",
    })
  })

  it("merges fee estimates on mongoose documents without losing core fields", () => {
    const mongooseDoc = {
      amount: "50.00",
      currency: "usdt",
      externalAccountId: "ext-1",
      status: "pending",
      createdAt: new Date("2026-06-11T00:00:00.000Z"),
      toObject: () => ({
        _id: { toString: () => "w-mongo" },
        amount: "50.00",
        currency: "usdt",
        externalAccountId: "ext-1",
        status: "pending",
        createdAt: new Date("2026-06-11T00:00:00.000Z"),
      }),
    }

    const pending = presentBridgeWithdrawal(mongooseDoc, {
      flashFeePercent: "2",
      flashFee: "1.00",
      estimatedBridgeFeePercent: "0.6",
      estimatedBridgeFee: "0.30",
      estimatedGasBuffer: "5.85",
      estimatedCustomerFee: "7.15",
    })

    expect(pending.id).toBe("w-mongo")
    expect(pending.amount).toBe("50.00")
    expect(pending.currency).toBe("usdt")
    expect(pending.estimatedCustomerFee).toBe("7.15")
    expect(pending.subtotalAmount).toBe("42.85")
  })

  it("fills missing legacy fee fields when a fresh estimate is provided", () => {
    const pending = presentBridgeWithdrawal(
      {
        id: "w-legacy",
        amount: "50.00",
        currency: "usdt",
        externalAccountId: "ext-1",
        status: "pending",
        createdAt: "2026-06-11T00:00:00.000Z",
      },
      {
        flashFeePercent: "2",
        flashFee: "1.00",
        estimatedBridgeFeePercent: "0.6",
        estimatedBridgeFee: "0.30",
        estimatedGasBuffer: "5.85",
        estimatedCustomerFee: "7.15",
      },
    )

    expect(pending.estimatedBridgeFeePercent).toBe("0.6")
    expect(pending.estimatedGasBuffer).toBe("5.85")
    expect(pending.estimatedCustomerFee).toBe("7.15")
    expect(pending.subtotalAmount).toBe("42.85")
  })

  it("exposes pending amount estimates until Bridge receipt fees are stored", () => {
    const pending = presentBridgeWithdrawal({
      id: "w-1",
      amount: "50.00",
      currency: "usdt",
      externalAccountId: "ext-1",
      status: "pending",
      flashFeePercent: "2",
      flashFee: "1.00",
      estimatedBridgeFeePercent: "0.6",
      estimatedBridgeFee: "0.30",
      estimatedGasBuffer: "5.85",
      estimatedCustomerFee: "7.15",
      createdAt: "2026-06-11T00:00:00.000Z",
    })

    expect(pending.flashFeeIsEstimate).toBe(true)
    expect(pending.flashFee).toBe("1.00")
    expect(pending.estimatedCustomerFee).toBe("7.15")
    expect(pending.subtotalAmount).toBe("42.85")
    expect(pending.finalAmount).toBe("42.85")
  })

  it("uses receipt amounts once Bridge fees are available", () => {
    const submitted = presentBridgeWithdrawal({
      id: "w-1",
      amount: "49.00",
      currency: "usd",
      externalAccountId: "ext-1",
      status: "submitted",
      flashFeePercent: "2",
      flashFee: "1.00",
      estimatedBridgeFeePercent: "0.6",
      estimatedBridgeFee: "0.30",
      estimatedGasBuffer: "5.85",
      estimatedCustomerFee: "7.15",
      bridgeDeveloperFee: "0.30",
      bridgeExchangeFee: "0.10",
      subtotalAmount: "48.90",
      finalAmount: "48.90",
      bridgeTransferId: "tr-1",
      createdAt: "2026-06-11T00:00:00.000Z",
    })

    expect(submitted.flashFeeIsEstimate).toBe(false)
    expect(submitted.subtotalAmount).toBe("48.90")
    expect(submitted.finalAmount).toBe("48.90")
  })

  it("maps Bridge transfer receipt fields", () => {
    expect(
      receiptFeesFromTransfer({
        developer_fee: "0.30",
        exchange_fee: "0.10",
        subtotal_amount: "48.90",
        final_amount: "48.90",
      }),
    ).toEqual({
      bridgeDeveloperFee: "0.30",
      bridgeExchangeFee: "0.10",
      subtotalAmount: "48.90",
      finalAmount: "48.90",
    })
  })
})
