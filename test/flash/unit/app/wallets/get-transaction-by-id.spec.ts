/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Test suite for getTransactionDetailsById function
 *
 * This test suite focuses on the data parsing and transformation logic of the
 * getTransactionDetailsById function. The function receives transaction data from
 * the Ibex API and transforms it into a standardized format for the application.
 *
 * Key areas tested:
 * - Lightning transaction parsing (invoice objects -> flat fields)
 * - OnChain transaction parsing (nested onChainTransaction -> flat fields)
 * - Error handling for API failures and blockchain service errors
 * - Data type conversions (objects with name/value properties -> strings)
 * - Fee calculation priority from multiple sources
 * - Confirmation calculation using blockchain height
 * - Edge cases and fallback behaviors
 */

import { getTransactionDetailsById } from "@app/wallets/get-transaction-by-id"

// Mock all external dependencies to isolate the function under test
// This ensures tests are deterministic and don't depend on external services
const mockGetTransactionDetails = jest.fn()
const mockGetCurrentBlockHeight = jest.fn()

jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: {
    getTransactionDetails: (...args: any[]) => mockGetTransactionDetails(...args),
  },
}))

jest.mock("@services/blockchain", () => ({
  BlockchainService: {
    getCurrentBlockHeight: (...args: any[]) => mockGetCurrentBlockHeight(...args),
  },
}))
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
jest.mock("@services/tracing", () => ({
  recordExceptionInCurrentSpan: jest.fn(),
  ErrorLevel: { Warn: "warn", Critical: "critical" },
  addAttributesToCurrentSpan: jest.fn(),
  wrapAsyncFunctionsToRunInSpan: jest.fn(),
}))

describe("getTransactionDetailsById - Parsing Logic", () => {
  // Standard test transaction ID used across all tests
  const mockTxId = "tx-id" as IbexTransactionId

  // Clear all mocks before each test to ensure test isolation
  beforeEach(() => jest.clearAllMocks())

  /**
   * Test: Lightning invoice object parsing
   *
   * Verifies that nested invoice objects are correctly flattened into top-level fields.
   * The Ibex API returns Lightning invoices as nested objects with properties like:
   * - invoice.bolt11 -> extracted as top-level 'invoice'
   * - invoice.hash -> extracted as top-level 'paymentHash'
   * - invoice.preImage -> extracted as top-level 'paymentPreimage'
   * - invoice.memo -> extracted as top-level 'memo'
   */
  it("parses Lightning invoice object into flat fields", async () => {
    const mockResponse: any = {
      id: "1",
      accountId: "acc1",
      amount: 1000,
      currency: "BTC",
      status: "COMPLETED",
      type: "LIGHTNING",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      // Nested invoice object structure from Ibex API
      invoice: { bolt11: "lnbc...", hash: "h1", preImage: "p1", memo: "test" },
    }
    mockGetTransactionDetails.mockResolvedValue(mockResponse)

    const result = await getTransactionDetailsById(mockTxId)

    // Verify that nested invoice fields are extracted to top level
    expect(result).toMatchObject({
      invoice: "lnbc...", // From invoice.bolt11
      paymentHash: "h1", // From invoice.hash
      paymentPreimage: "p1", // From invoice.preImage
      memo: "test", // From invoice.memo
    })
  })

  /**
   * Test: OnChain transaction object parsing with confirmation calculation
   *
   * Verifies that nested onChainTransaction objects are correctly flattened and that
   * confirmations are calculated using blockchain height. Tests the transformation:
   * - onChainTransaction.destAddress -> address
   * - onChainTransaction.networkTxId -> txid
   * - onChainTransaction.feeSat -> fee (preferred over other fee fields)
   * - Confirmation calculation: currentHeight - blockheight = confirmations
   * - Status extraction from nested status.value
   */
  it("parses onChainTransaction nested object", async () => {
    const mockResponse: any = {
      id: "2",
      accountId: "acc2",
      amount: 50000,
      currency: "BTC",
      status: "PENDING",
      type: "ONCHAIN",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      onChainTransaction: {
        destAddress: "bc1q...",
        networkTxId: "txid1",
        vout: 0,
        feeSat: 500,
        blockheight: 100,
        status: { value: "CONFIRMED" },
      },
    }
    mockGetTransactionDetails.mockResolvedValue(mockResponse)
    // Mock blockchain height higher than tx blockheight for confirmation calculation
    mockGetCurrentBlockHeight.mockResolvedValue(110)

    const result = await getTransactionDetailsById(mockTxId)

    expect(result).toMatchObject({
      address: "bc1q...", // From onChainTransaction.destAddress
      txid: "txid1", // From onChainTransaction.networkTxId
      vout: 0,
      confirmations: 10, // 110 - 100 = 10 confirmations
      fee: 500, // From onChainTransaction.feeSat (preferred fee source)
    })
  })

  /**
   * Test: Currency object parsing
   *
   * Tests that currency objects with a 'name' property are flattened to just the string value.
   * The Ibex API sometimes returns currency as { name: "USD" } instead of just "USD".
   * The function should extract the name property and use it as the currency value.
   */
  it("handles currency as object", async () => {
    const mockResponse: any = {
      id: "3",
      accountId: "acc3",
      amount: 100,
      currency: { name: "USD" }, // Currency as object with name property
      status: "DONE",
      type: "TRANSFER",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    }
    mockGetTransactionDetails.mockResolvedValue(mockResponse)

    const result = await getTransactionDetailsById(mockTxId)

    // Should extract currency.name and flatten to top-level string
    expect(result).toMatchObject({ currency: "USD" })
  })

  /**
   * Test: Status precedence from onChainTransaction
   *
   * Tests that status from onChainTransaction.status.value takes precedence over
   * the top-level status field. This is important for onchain transactions where
   * the nested status reflects the actual blockchain status rather than the
   * internal Ibex transaction status.
   */
  it("handles status from onChainTransaction", async () => {
    const mockResponse: any = {
      id: "4",
      accountId: "acc4",
      amount: 1000,
      currency: "BTC",
      status: "UNKNOWN", // Top-level status
      type: "ONCHAIN",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      onChainTransaction: { status: { value: "CONFIRMED" } }, // Nested status should win
    }
    mockGetTransactionDetails.mockResolvedValue(mockResponse)

    const result = await getTransactionDetailsById(mockTxId)

    // Should use onChainTransaction.status.value instead of top-level status
    expect(result).toMatchObject({ status: "CONFIRMED" })
  })

  /**
   * Test: Error handling from Ibex API
   *
   * Tests that when the Ibex API returns an error object instead of transaction data,
   * the function correctly propagates this error to the caller.
   * This simulates API failures or invalid transaction ID scenarios.
   */
  it("returns error when Ibex returns error", async () => {
    // Create an error that matches the expected type signature
    const mockError = new Error("Ibex error") as any
    mockGetTransactionDetails.mockResolvedValue(mockError)

    const result = await getTransactionDetailsById(mockTxId)

    // Should propagate the error returned by Ibex
    expect(result).toBeInstanceOf(Error)
  })

  /**
   * Test: Blockchain service error handling with fallback confirmations
   *
   * Tests that when the blockchain service returns an error (e.g., API down),
   * the function gracefully falls back to a default confirmation count.
   * This ensures the application continues to function even when external
   * blockchain APIs are unavailable.
   */
  it("handles blockchain service errors gracefully", async () => {
    const mockResponse: any = {
      id: "5",
      accountId: "acc5",
      amount: 1000,
      currency: "BTC",
      status: "PENDING",
      type: "ONCHAIN",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      onChainTransaction: {
        blockheight: 100,
        status: { value: "CONFIRMED" },
      },
    }
    mockGetTransactionDetails.mockResolvedValue(mockResponse)
    // Mock blockchain service to return an error instead of current height
    mockGetCurrentBlockHeight.mockResolvedValue(new Error("API down"))

    const result = await getTransactionDetailsById(mockTxId)

    // Should fallback to default confirmation count when blockchain service fails
    expect(result).toMatchObject({ confirmations: 6 }) // DEFAULT_CONFIRMED_BLOCKS
  })

  /**
   * Test: Lightning invoice as string (direct fields)
   *
   * Tests handling of Lightning transactions where invoice data is already
   * provided as flat fields instead of nested objects. This covers the case
   * where the API returns invoice, paymentHash, paymentPreimage, and memo
   * as direct properties rather than nested within an invoice object.
   */
  it("handles Lightning invoice as string", async () => {
    const mockResponse: any = {
      id: "6",
      accountId: "acc6",
      amount: 2000,
      currency: "BTC",
      status: "COMPLETED",
      type: "LIGHTNING",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      // Direct fields instead of nested invoice object
      invoice: "lnbc2000n1...",
      paymentHash: "hash123",
      paymentPreimage: "preimage123",
      memo: "direct memo",
    }
    mockGetTransactionDetails.mockResolvedValue(mockResponse)

    const result = await getTransactionDetailsById(mockTxId)

    // Should use direct fields when invoice is not an object
    expect(result).toMatchObject({
      invoice: "lnbc2000n1...",
      paymentHash: "hash123",
      paymentPreimage: "preimage123",
      memo: "direct memo",
    })
  })

  /**
   * Test: TransactionType object parsing
   *
   * Tests parsing of transactionType when it's provided as an object with a 'name' property.
   * The function should extract the name and use it as the transaction type.
   * Maps transactionType.name -> type field in the result.
   */
  it("handles transactionType as object", async () => {
    const mockResponse: any = {
      id: "7",
      accountId: "acc7",
      amount: 500,
      currency: "BTC",
      status: "COMPLETED",
      transactionType: { name: "LIGHTNING_PAYMENT" }, // Object with name property
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    }
    mockGetTransactionDetails.mockResolvedValue(mockResponse)

    const result = await getTransactionDetailsById(mockTxId)

    // Should extract transactionType.name as the type field
    expect(result).toMatchObject({ type: "LIGHTNING_PAYMENT" })
  })

  /**
   * Test: Type object parsing
   *
   * Tests parsing of type when it's provided as an object with a 'name' property.
   * Similar to transactionType handling but for the 'type' field directly.
   * Extracts type.name -> type field in the result.
   */
  it("handles type as object", async () => {
    const mockResponse: any = {
      id: "8",
      accountId: "acc8",
      amount: 750,
      currency: "BTC",
      status: "COMPLETED",
      type: { name: "ONCHAIN_RECEIVE" }, // Type as object with name property
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    }
    mockGetTransactionDetails.mockResolvedValue(mockResponse)

    const result = await getTransactionDetailsById(mockTxId)

    // Should extract type.name as the type field
    expect(result).toMatchObject({ type: "ONCHAIN_RECEIVE" })
  })

  /**
   * Test: Status object parsing with name property
   *
   * Tests parsing of status when it's provided as an object with a 'name' property.
   * The Ibex API sometimes returns status as { name: "PENDING_CONFIRMATION" }
   * instead of just "PENDING_CONFIRMATION". The function should extract the name.
   */
  it("handles status as object with name property", async () => {
    const mockResponse: any = {
      id: "9",
      accountId: "acc9",
      amount: 1500,
      currency: "BTC",
      status: { name: "PENDING_CONFIRMATION" }, // Status as object with name
      type: "ONCHAIN",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    }
    mockGetTransactionDetails.mockResolvedValue(mockResponse)

    const result = await getTransactionDetailsById(mockTxId)

    // Should extract status.name as the status field
    expect(result).toMatchObject({ status: "PENDING_CONFIRMATION" })
  })

  /**
   * Test: Fallback confirmations when blockheight is missing
   *
   * Tests that when blockheight is not available for calculation, the function
   * uses the existing confirmations value from the transaction data.
   * This ensures transactions still display confirmation info even when
   * blockchain height calculation is not possible.
   */
  it("handles missing blockheight with fallback confirmations", async () => {
    const mockResponse: any = {
      id: "10",
      accountId: "acc10",
      amount: 3000,
      currency: "BTC",
      status: "CONFIRMED",
      type: "ONCHAIN",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      onChainTransaction: {
        destAddress: "bc1q...",
        networkTxId: "txid2",
        confirmations: 12, // Pre-calculated confirmations
        status: { value: "CONFIRMED" },
        // Note: no blockheight field for calculation
      },
    }
    mockGetTransactionDetails.mockResolvedValue(mockResponse)

    const result = await getTransactionDetailsById(mockTxId)

    // Should use existing confirmations when blockheight not available
    expect(result).toMatchObject({ confirmations: 12 })
  })

  /**
   * Test: Fee source prioritization
   *
   * Tests the fee calculation priority when multiple fee fields are present.
   * The function should prefer onChainTransaction.feeSat over other fee fields
   * like fee, networkFee, and onChainSendFee for better accuracy.
   * Priority order: feeSat > fee > networkFee > onChainSendFee
   */
  it("handles mixed fee sources preferring onChain data", async () => {
    const mockResponse: any = {
      id: "11",
      accountId: "acc11",
      amount: 4000,
      currency: "BTC",
      status: "CONFIRMED",
      type: "ONCHAIN",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      fee: 200, // Lower priority
      networkFee: 300, // Lower priority
      onChainSendFee: 400, // Lower priority
      onChainTransaction: {
        feeSat: 150, // Highest priority - should be used
        status: { value: "CONFIRMED" },
      },
    }
    mockGetTransactionDetails.mockResolvedValue(mockResponse)

    const result = await getTransactionDetailsById(mockTxId)

    // Should prefer onChainTransaction.feeSat over other fee fields
    expect(result).toMatchObject({ fee: 150 })
  })

  /**
   * Test: Empty currency object handling
   *
   * Tests graceful handling of empty currency objects from the Ibex API.
   * When currency is an empty object {}, the function should return an empty string
   * rather than crashing or returning undefined.
   */
  it("handles empty currency object gracefully", async () => {
    const mockResponse: any = {
      id: "12",
      accountId: "acc12",
      amount: 100,
      currency: {}, // Empty object instead of { name: "..." }
      status: "COMPLETED",
      type: "TRANSFER",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    }
    mockGetTransactionDetails.mockResolvedValue(mockResponse)

    const result = await getTransactionDetailsById(mockTxId)

    // Should return empty string for empty currency object
    expect(result).toMatchObject({ currency: "" })
  })

  /**
   * Test: Null invoice handling
   *
   * Tests handling of Lightning transactions where the invoice field is null.
   * The function should gracefully handle this case by setting all Lightning-specific
   * fields to undefined rather than attempting to access properties of null.
   */
  it("handles null invoice object", async () => {
    const mockResponse: any = {
      id: "13",
      accountId: "acc13",
      amount: 500,
      currency: "BTC",
      status: "COMPLETED",
      type: "LIGHTNING",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      invoice: null, // Null invoice instead of object or string
    }
    mockGetTransactionDetails.mockResolvedValue(mockResponse)

    const result = await getTransactionDetailsById(mockTxId)

    // Should set all invoice-related fields to undefined when invoice is null
    expect(result).toMatchObject({
      invoice: undefined,
      paymentHash: undefined,
      paymentPreimage: undefined,
      memo: undefined,
    })
  })

  /**
   * Test: Exception handling from network errors
   *
   * Tests that when the Ibex client throws an exception (e.g., network error),
   * the function catches it and returns a properly formatted error object.
   * This simulates real-world scenarios like network timeouts or API unavailability.
   */
  it("throws error and handles it gracefully", async () => {
    mockGetTransactionDetails.mockRejectedValue(new Error("Network error"))

    const result = await getTransactionDetailsById(mockTxId)

    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toContain(
      "Failed to fetch transaction details: Network error",
    )
  })

  /**
   * Test: Unknown error type handling
   *
   * Tests that when the Ibex client rejects with a non-Error object
   * (e.g., string, number, null), the function still handles it gracefully
   * and returns a proper Error object with a meaningful message.
   */
  it("handles unknown error type", async () => {
    // Mock rejection with non-Error type
    mockGetTransactionDetails.mockRejectedValue("String error")

    const result = await getTransactionDetailsById(mockTxId)

    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toContain(
      "Failed to fetch transaction details due to unknown error",
    )
  })

  /**
   * Test: Edge case - Zero blockheight calculation
   *
   * Tests confirmation calculation when the transaction has blockheight of 0
   * (which can happen with unconfirmed or edge case transactions).
   * This ensures the mathematical calculation doesn't break with edge values.
   */
  it("calculates confirmations with zero blockheight", async () => {
    const mockResponse: any = {
      id: "14",
      accountId: "acc14",
      amount: 1000,
      currency: "BTC",
      status: "CONFIRMED",
      type: "ONCHAIN",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      onChainTransaction: {
        blockheight: 0, // Edge case: zero blockheight
        status: { value: "CONFIRMED" },
      },
    }
    mockGetTransactionDetails.mockResolvedValue(mockResponse)
    mockGetCurrentBlockHeight.mockResolvedValue(850000)

    const result = await getTransactionDetailsById(mockTxId)

    // Should calculate: currentHeight - blockheight = 850000 - 0 = 850000
    expect(result).toMatchObject({ confirmations: 850000 })
  })
})
