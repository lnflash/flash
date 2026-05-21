/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Test suite for toWalletTransactions and getTransactionsForWallets
 *
 * These tests focus on the Ibex API response transformation logic:
 * - Correct price offset based on wallet currency (BTC → 12, USD → 6)
 * - Math.round() instead of Math.floor() - prevents truncating small rates to 0
 * - JMD display currency conversion using static ExchangeRates config
 * - Correct settlementDisplayPrice construction
 */

import { toWalletTransactions } from "@app/wallets/get-transactions-for-wallet"
import { UsdDisplayCurrency, JmdDisplayCurrency } from "@domain/fiat"

// Mock Ibex client to break the complex dependency chain (mongoose, etc.)
jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: {},
}))

// Mock the config ExchangeRates for JMD conversion tests
jest.mock("@config", () => {
  // Create a minimal JMDAmount mock
  const JMDAmount = {
    dollars: jest.fn((d: number) => ({
      asCents: () => String(Math.round(d * 100)),
      asDollars: () => d.toFixed(2),
    })),
  }

  return {
    ExchangeRates: {
      jmd: {
        sell: JMDAmount.dollars(160), // 1 USD = 160 JMD
      },
    },
  }
})

jest.mock("@services/logger", () => ({
  baseLogger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    child: jest.fn(() => ({
      warn: jest.fn(),
      error: jest.fn(),
      info: jest.fn(),
    })),
  },
}))

describe("toWalletTransactions", () => {
  describe("USD wallet currency (currencyId === 3)", () => {
    const usdTx = {
      accountId: "acc1",
      amount: 1000,
      currencyId: 3, // USD
      transactionTypeId: 1, // Lightning receive
      exchangeRateCurrencySats: 0.001, // 1 sat = $0.001 = 0.1 USD cents
      networkFee: 5,
      id: "tx1",
      createdAt: "2024-01-01T00:00:00Z",
    }

    it("uses USD_PRICE_PRECISION_OFFSET (6) for USD wallet transactions", () => {
      const result = toWalletTransactions([usdTx as any], UsdDisplayCurrency)
      expect(result[0].settlementDisplayPrice.offset).toBe(6n)
      expect(result[0].settlementDisplayPrice.walletCurrency).toBe("USD")
    })

    it("scales the exchange rate base by 10^6 for USD wallet", () => {
      // 0.001 * 10^6 = 1000
      const result = toWalletTransactions([usdTx as any], UsdDisplayCurrency)
      expect(result[0].settlementDisplayPrice.base).toBe(1000n)
    })

    it("uses the provided displayCurrency instead of hardcoded USD", () => {
      const result = toWalletTransactions(
        [usdTx as any],
        UsdDisplayCurrency,
      )
      expect(result[0].settlementDisplayPrice.displayCurrency).toBe("USD")
    })
  })

  describe("BTC wallet currency (currencyId !== 3)", () => {
    const btcTx = {
      accountId: "acc2",
      amount: 100000,
      currencyId: 1, // BTC
      transactionTypeId: 1,
      exchangeRateCurrencySats: 0.00007, // 1 sat = 0.00007 USD
      networkFee: 50,
      id: "tx2",
      createdAt: "2024-01-01T00:00:00Z",
    }

    it("uses SAT_PRICE_PRECISION_OFFSET (12) for BTC wallet transactions", () => {
      const result = toWalletTransactions([btcTx as any], UsdDisplayCurrency)
      expect(result[0].settlementDisplayPrice.offset).toBe(12n)
      expect(result[0].settlementDisplayPrice.walletCurrency).toBe("BTC")
    })

    it("scales the exchange rate base by 10^12 for BTC wallet", () => {
      // 0.00007 * 10^12 = 70000000
      const result = toWalletTransactions([btcTx as any], UsdDisplayCurrency)
      expect(result[0].settlementDisplayPrice.base).toBe(70000000n)
    })
  })

  describe("Math.floor vs Math.round fix", () => {
    it("uses Math.round() so small exchange rates don't truncate to 0", () => {
      // A very small exchange rate: 0.00000007 USD per sat
      // Math.floor(0.00000007 * 10^12) = 0 - BUG!
      // Math.round(0.00000007 * 10^12) = 70000 - CORRECT
      const tx = {
        accountId: "acc3",
        amount: 5000,
        currencyId: 1, // BTC
        transactionTypeId: 1,
        exchangeRateCurrencySats: 0.00000007,
        createdAt: "2024-01-01T00:00:00Z",
        id: "tx3",
      }
      const result = toWalletTransactions([tx as any], UsdDisplayCurrency)
      // With Math.floor: base would be 0n
      // With Math.round: base should be 70000n
      expect(result[0].settlementDisplayPrice.base).toBeGreaterThan(0n)
      expect(result[0].settlementDisplayPrice.base).toBe(70000n)
    })

    it("handles undefined exchangeRateCurrencySats gracefully", () => {
      const tx = {
        accountId: "acc4",
        amount: 1000,
        currencyId: 3, // USD
        transactionTypeId: 1,
        createdAt: "2024-01-01T00:00:00Z",
        id: "tx4",
      }
      const result = toWalletTransactions([tx as any], UsdDisplayCurrency)
      expect(result[0].settlementDisplayPrice.base).toBe(0n)
      expect(result[0].settlementDisplayPrice.offset).toBe(6n)
    })
  })

  describe("JMD display currency conversion", () => {
    const usdTx = {
      accountId: "acc5",
      amount: 1000, // 1000 USD cents = $10.00
      currencyId: 3, // USD
      transactionTypeId: 1,
      exchangeRateCurrencySats: 0.001,
      networkFee: 5,
      id: "tx5",
      createdAt: "2024-01-01T00:00:00Z",
    }

    it("converts settlementDisplayAmount to JMD when displayCurrency is JMD", () => {
      // 1000 USD cents = $10.00 USD
      // 1 USD = 160 JMD → $10.00 USD = 1600 JMD dollars = 160000 JMD cents
      const result = toWalletTransactions([usdTx as any], JmdDisplayCurrency)
      expect(result[0].settlementDisplayAmount).toBe("160000")
    })

    it("converts settlementDisplayFee to JMD when displayCurrency is JMD", () => {
      // 5 USD cents × 160 JMD/USD = 800 JMD cents
      const result = toWalletTransactions([usdTx as any], JmdDisplayCurrency)
      expect(result[0].settlementDisplayFee).toBe("800")
    })

    it("does not convert to JMD when displayCurrency is USD (default)", () => {
      const result = toWalletTransactions([usdTx as any], UsdDisplayCurrency)
      // Amount should pass through as-is (raw string from Ibex)
      expect(result[0].settlementDisplayAmount).toBe("1000")
      expect(result[0].settlementDisplayFee).toBe("5")
    })
  })

  describe("Transaction type parsing", () => {
    it("maps transactionTypeId 1 to Lightning receive", () => {
      const tx = {
        accountId: "acc6",
        amount: 500,
        currencyId: 1,
        transactionTypeId: 1, // Lightning receive
        createdAt: "2024-01-01T00:00:00Z",
        id: "tx6",
      }
      const result = toWalletTransactions([tx as any], UsdDisplayCurrency)
      expect(result[0].initiationVia).toMatchObject({ type: "lightning" })
      expect(result[0].settlementVia).toMatchObject({ type: "lightning" })
    })

    it("maps transactionTypeId 3 to Onchain receive", () => {
      const tx = {
        accountId: "acc7",
        amount: 50000,
        currencyId: 1,
        transactionTypeId: 3, // Onchain receive
        createdAt: "2024-01-01T00:00:00Z",
        id: "tx7",
      }
      const result = toWalletTransactions([tx as any], UsdDisplayCurrency)
      expect(result[0].initiationVia).toMatchObject({ type: "onchain" })
      expect(result[0].settlementVia).toMatchObject({ type: "onchain" })
    })
  })

  describe("Settlement amounts", () => {
    it("makes receive amounts positive", () => {
      const tx = {
        accountId: "acc8",
        amount: 2000,
        currencyId: 3, // USD
        transactionTypeId: 1, // Lightning receive
        createdAt: "2024-01-01T00:00:00Z",
        id: "tx8",
      }
      const result = toWalletTransactions([tx as any], UsdDisplayCurrency)
      expect(result[0].settlementAmount).toBe(2000) // positive
    })

    it("makes send amounts negative", () => {
      const tx = {
        accountId: "acc9",
        amount: 1500,
        currencyId: 3, // USD
        transactionTypeId: 2, // Lightning send
        createdAt: "2024-01-01T00:00:00Z",
        id: "tx9",
      }
      const result = toWalletTransactions([tx as any], UsdDisplayCurrency)
      expect(result[0].settlementAmount).toBe(-1500) // negative
    })

    it("handles missing amount gracefully", () => {
      const tx = {
        accountId: "acc10",
        currencyId: 3,
        transactionTypeId: 1,
        createdAt: "2024-01-01T00:00:00Z",
        id: "tx10",
      }
      const result = toWalletTransactions([tx as any], UsdDisplayCurrency)
      expect(result[0].settlementAmount).toBeUndefined()
    })
  })
})
