import { WalletCurrency } from "@domain/shared"

import {
  matchBridgeDepositsToIbex,
  NOTIFY_WITHIN_MS,
} from "@app/bridge/match-ibex-deposits"

// ENG-891: IBEX credits a Bridge virtual-account deposit but never tells
// Flash. The hourly matcher finds the credit by its on-chain tx hash, read
// from IBEX's transaction details, and records it.

const mockFind = jest.fn()
const mockFindProcessed = jest.fn()
const mockLookup = jest.fn()
const mockListWallets = jest.fn()
const mockGetAccountTransactions = jest.fn()
const mockGetNetworkId = jest.fn()
const mockRecord = jest.fn()

jest.mock("@services/mongoose/schema", () => ({
  BridgeDeposits: { find: (...args: unknown[]) => mockFind(...args) },
}))

jest.mock("@services/mongoose/ibex-crypto-receive-log", () => ({
  findProcessedIbexCryptoReceiveTxHashes: (...args: unknown[]) =>
    mockFindProcessed(...args),
}))

jest.mock("@services/bridge/account-lookup", () => ({
  findAccountByBridgeCustomerId: (...args: unknown[]) => mockLookup(...args),
}))

jest.mock("@app/wallets", () => ({
  listWalletsByAccountId: (...args: unknown[]) => mockListWallets(...args),
}))

jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: {
    getAccountTransactions: (...args: unknown[]) => mockGetAccountTransactions(...args),
    getTransactionNetworkId: (...args: unknown[]) => mockGetNetworkId(...args),
  },
}))

jest.mock("@app/bridge/record-crypto-receive", () => ({
  recordIbexCryptoReceive: (...args: unknown[]) => mockRecord(...args),
}))

jest.mock("@services/logger", () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  return { baseLogger: { ...logger, child: () => logger } }
})

const NOW = new Date("2026-11-20T12:00:00Z")
const HOUR = 60 * 60 * 1000
const HASH = "0xd8c9e8938489dac2da8632dfae42d3cc8065fa1174a517470d71863574bf346a"
const OTHER_HASH = "0x1111111111111111111111111111111111111111111111111111111111111111"
const ADDRESS = "0xdeposit"
const ACCOUNT = { id: "account-1", bridgeEthereumAddress: ADDRESS }
const USDT_WALLET = { id: "ibex-usdt-1", currency: WalletCurrency.Usdt }

const deposit = (overrides: Record<string, unknown> = {}) => ({
  transferId: "deposit-1",
  customerId: "customer-1",
  destinationTxHash: HASH,
  createdAt: new Date(NOW.getTime() - 2 * HOUR),
  ...overrides,
})

const credit = (overrides: Record<string, unknown> = {}) => ({
  id: "ibex-tx-1",
  createdAt: new Date(NOW.getTime() - 2 * HOUR).toISOString(),
  settledAt: new Date(NOW.getTime() - 2 * HOUR + 3 * 60_000).toISOString(),
  amount: 489.51,
  transactionTypeId: 9,
  ...overrides,
})

const givenDeposits = (rows: unknown[]) => {
  mockFind.mockReturnValue({
    sort: () => ({ lean: () => Promise.resolve(rows) }),
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  givenDeposits([deposit()])
  mockFindProcessed.mockResolvedValue(new Set())
  mockLookup.mockResolvedValue({ kind: "found", account: ACCOUNT })
  mockListWallets.mockResolvedValue([
    { id: "ibex-usd-1", currency: WalletCurrency.Usd },
    USDT_WALLET,
  ])
  mockGetAccountTransactions.mockResolvedValue([credit()])
  mockGetNetworkId.mockResolvedValue(HASH)
  mockRecord.mockResolvedValue({ status: "success" })
})

describe("matchBridgeDepositsToIbex", () => {
  it("records the IBEX credit whose tx hash equals the deposit's", async () => {
    const summary = await matchBridgeDepositsToIbex({ now: NOW })

    expect(summary).toEqual({
      pending: 1,
      matched: 1,
      alreadyProcessed: 0,
      unmatched: 0,
      failures: 0,
    })
    expect(mockLookup).toHaveBeenCalledWith("customer-1")
    expect(mockGetAccountTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ account_id: USDT_WALLET.id, page: 0 }),
    )
    expect(mockGetNetworkId).toHaveBeenCalledWith("ibex-tx-1")
    expect(mockRecord).toHaveBeenCalledWith({
      txHash: HASH,
      address: ADDRESS,
      amount: 489.51,
      ibexTransactionId: "ibex-tx-1",
      notifyUser: true,
      rawPayload: expect.objectContaining({
        source: "ibex_deposit_matcher",
        ibexTransactionId: "ibex-tx-1",
        bridgeTransferId: "deposit-1",
      }),
    })
  })

  it("reads only payment_processed deposits with a tx hash from the lookback", async () => {
    await matchBridgeDepositsToIbex({ now: NOW, lookbackMs: 24 * HOUR })

    expect(mockFind).toHaveBeenCalledWith(
      {
        state: "payment_processed",
        destinationTxHash: { $type: "string", $ne: "" },
        createdAt: { $gte: new Date(NOW.getTime() - 24 * HOUR) },
      },
      expect.anything(),
    )
  })

  it("matches a tx hash whatever its letter case", async () => {
    mockGetNetworkId.mockResolvedValue(HASH.toUpperCase().replace("0X", "0x"))

    const summary = await matchBridgeDepositsToIbex({ now: NOW })

    expect(summary).toEqual(expect.objectContaining({ matched: 1 }))
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ txHash: HASH }))
  })

  it("leaves a deposit unmatched when no credit carries its hash", async () => {
    mockGetNetworkId.mockResolvedValue(OTHER_HASH)

    const summary = await matchBridgeDepositsToIbex({ now: NOW })

    expect(summary).toEqual(expect.objectContaining({ matched: 0, unmatched: 1 }))
    expect(mockRecord).not.toHaveBeenCalled()
  })

  it("never matches on amount or time alone", async () => {
    // Same amount and timing as the deposit, different on-chain transaction.
    mockGetNetworkId.mockResolvedValue(OTHER_HASH)
    mockGetAccountTransactions.mockResolvedValue([credit(), credit({ id: "ibex-tx-2" })])

    const summary = await matchBridgeDepositsToIbex({ now: NOW })

    expect(summary).toEqual(expect.objectContaining({ unmatched: 1 }))
    expect(mockRecord).not.toHaveBeenCalled()
  })

  it("picks the right credit among several and stops reading details once all are found", async () => {
    mockGetAccountTransactions.mockResolvedValue([
      credit({ id: "ibex-tx-newer" }),
      credit({ id: "ibex-tx-match" }),
      credit({ id: "ibex-tx-older" }),
    ])
    mockGetNetworkId.mockImplementation(async (id: string) =>
      id === "ibex-tx-match" ? HASH : OTHER_HASH,
    )

    await matchBridgeDepositsToIbex({ now: NOW })

    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({ ibexTransactionId: "ibex-tx-match" }),
    )
    expect(mockGetNetworkId).toHaveBeenCalledTimes(2)
  })

  it("only looks at crypto receives settled from shortly before the deposit", async () => {
    mockGetAccountTransactions.mockResolvedValue([
      credit({ id: "lightning", transactionTypeId: 1 }),
      credit({ id: "crypto-send", transactionTypeId: 10 }),
      credit({
        id: "too-old",
        settledAt: new Date(NOW.getTime() - 3 * HOUR).toISOString(),
      }),
      credit({ id: "ibex-tx-1" }),
    ])

    await matchBridgeDepositsToIbex({ now: NOW })

    expect(mockGetNetworkId).toHaveBeenCalledTimes(1)
    expect(mockGetNetworkId).toHaveBeenCalledWith("ibex-tx-1")
  })

  it("does not notify the user about a credit settled more than a day ago", async () => {
    givenDeposits([deposit({ createdAt: new Date(NOW.getTime() - 6 * 24 * HOUR) })])
    mockGetAccountTransactions.mockResolvedValue([
      credit({
        settledAt: new Date(NOW.getTime() - NOTIFY_WITHIN_MS - 1000).toISOString(),
      }),
    ])

    const summary = await matchBridgeDepositsToIbex({ now: NOW })

    expect(summary).toEqual(expect.objectContaining({ matched: 1 }))
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({ notifyUser: false }),
    )
  })

  it("skips deposits whose receive is already processed, without calling IBEX", async () => {
    mockFindProcessed.mockResolvedValue(new Set([HASH]))

    const summary = await matchBridgeDepositsToIbex({ now: NOW })

    expect(summary).toEqual({
      pending: 0,
      matched: 0,
      alreadyProcessed: 1,
      unmatched: 0,
      failures: 0,
    })
    expect(mockLookup).not.toHaveBeenCalled()
    expect(mockGetAccountTransactions).not.toHaveBeenCalled()
  })

  it("treats repeated deposit rows for one tx hash as one deposit", async () => {
    givenDeposits([deposit(), deposit({ transferId: "deposit-1", eventId: "retry" })])

    const summary = await matchBridgeDepositsToIbex({ now: NOW })

    expect(summary).toEqual(expect.objectContaining({ pending: 1, matched: 1 }))
    expect(mockRecord).toHaveBeenCalledTimes(1)
  })

  it("counts a failure, not a miss, when a details read failed and nothing matched", async () => {
    mockGetNetworkId.mockResolvedValue(new Error("IBEX 503"))

    const summary = await matchBridgeDepositsToIbex({ now: NOW })

    expect(summary).toEqual(expect.objectContaining({ unmatched: 0, failures: 1 }))
    expect(mockRecord).not.toHaveBeenCalled()
  })

  it("counts a failure when IBEX credits cannot be read", async () => {
    mockGetAccountTransactions.mockResolvedValue(new Error("IBEX 503"))

    const summary = await matchBridgeDepositsToIbex({ now: NOW })

    expect(summary).toEqual(expect.objectContaining({ failures: 1 }))
  })

  it("counts a failure when recording the matched credit fails", async () => {
    mockRecord.mockResolvedValue({ status: "error", code: "erpnext_audit_failed" })

    const summary = await matchBridgeDepositsToIbex({ now: NOW })

    expect(summary).toEqual(expect.objectContaining({ matched: 0, failures: 1 }))
  })

  it("counts a receive recorded meanwhile as already processed", async () => {
    mockRecord.mockResolvedValue({ status: "already_processed" })

    const summary = await matchBridgeDepositsToIbex({ now: NOW })

    expect(summary).toEqual(expect.objectContaining({ matched: 0, alreadyProcessed: 1 }))
  })

  it("leaves a deposit unmatched when its customer has no Flash account", async () => {
    mockLookup.mockResolvedValue({ kind: "not_found" })

    const summary = await matchBridgeDepositsToIbex({ now: NOW })

    expect(summary).toEqual(expect.objectContaining({ unmatched: 1, failures: 0 }))
    expect(mockGetAccountTransactions).not.toHaveBeenCalled()
  })

  it("counts a failure when the account lookup fails, and goes on to the next customer", async () => {
    givenDeposits([
      deposit(),
      deposit({
        transferId: "deposit-2",
        customerId: "customer-2",
        destinationTxHash: OTHER_HASH,
      }),
    ])
    mockLookup.mockImplementation(async (customerId: string) =>
      customerId === "customer-1"
        ? { kind: "lookup_failed", error: new Error("mongo") }
        : { kind: "found", account: ACCOUNT },
    )
    mockGetNetworkId.mockResolvedValue(OTHER_HASH)

    const summary = await matchBridgeDepositsToIbex({ now: NOW })

    expect(summary).toEqual(expect.objectContaining({ failures: 1, matched: 1 }))
  })

  it("reads further pages until it reaches past the deposit", async () => {
    const fullPage = Array.from({ length: 50 }, (_, i) =>
      credit({ id: `other-${i}`, transactionTypeId: 1 }),
    )
    mockGetAccountTransactions
      .mockResolvedValueOnce(fullPage)
      .mockResolvedValueOnce([credit()])

    const summary = await matchBridgeDepositsToIbex({ now: NOW })

    expect(mockGetAccountTransactions).toHaveBeenCalledTimes(2)
    expect(mockGetAccountTransactions).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1 }),
    )
    expect(summary).toEqual(expect.objectContaining({ matched: 1 }))
  })

  it("returns an error when the deposits cannot be read", async () => {
    mockFind.mockImplementation(() => {
      throw new Error("mongo down")
    })

    const result = await matchBridgeDepositsToIbex({ now: NOW })

    expect(result).toBeInstanceOf(Error)
  })
})
