jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: {
    getAccountTransactions: jest.fn(),
  },
}))

import {
  getTransactionsForWallets,
  toWalletTransactions,
} from "@app/wallets/get-transactions-for-wallet"
import { WalletCurrency } from "@domain/shared"
import { WalletType } from "@domain/wallets"
import { LedgerTransactionType } from "@domain/ledger"
import Ibex from "@services/ibex/client"
import { IbexError } from "@services/ibex/errors"
import { baseLogger } from "@services/logger"
import { GResponse200 } from "ibex-client"

const mockGetTransactionsByWalletIds = jest.fn()

// The degraded path reads confirmed rows straight from the mongo ledger, so
// the harness needs the two pieces `ledgerHistoryForWallets` touches.
jest.mock("@services/ledger", () => ({
  LedgerService: () => ({
    getTransactionsByWalletIds: (
      ...args: Parameters<typeof mockGetTransactionsByWalletIds>
    ) => mockGetTransactionsByWalletIds(...args),
  }),
  getNonEndUserWalletIds: async () => ({ dealerBtc: "dealer-btc" }),
}))

import {
  markIbexUnavailable,
  resetIbexAvailability,
} from "@services/ibex/availability"

// A confirmed ledger row, already in the shape LedgerService returns (the real
// service maps its mongo documents through translateToLedgerTx).
const ledgerTxn = (id: string): LedgerTransaction<WalletCurrency> =>
  ({
    id,
    walletId: "33333333-3333-4333-8333-333333333333",
    type: LedgerTransactionType.Payment,
    credit: 1000,
    debit: 0,
    currency: WalletCurrency.Btc,
    timestamp: new Date("2026-06-01T00:00:00.000Z"),
    pendingConfirmation: false,
    journalId: "journal-id",
    lnMemo: "memo",
    feeKnownInAdvance: true,
    paymentHash: "payment-hash",
    pubkey: "pubkey",
    satsAmount: 1000,
    centsAmount: 20,
    satsFee: 0,
    centsFee: 0,
    displayAmount: 20,
    displayFee: 0,
    displayCurrency: "USD",
  }) as unknown as LedgerTransaction<WalletCurrency>

const accountId = "account-id" as AccountId

const wallet = ({ id, currency }: { id: string; currency: WalletCurrency }): Wallet =>
  ({
    id: id as WalletId,
    accountId,
    currency,
    type: WalletType.Checking,
    onChainAddressIdentifiers: [],
    onChainAddresses: () => [],
    lnurlp: `lnurlp-${id}` as Lnurl,
  }) as Wallet

describe("toWalletTransactions", () => {
  it("maps IBEX USDT currency id to USDT wallet currency with integer cents", () => {
    const transactions = toWalletTransactions([
      {
        id: "trx-id-1",
        accountId: "wallet-id",
        amount: 0.17531,
        currencyId: 29,
        transactionTypeId: 1,
        createdAt: "2026-05-13T00:00:00.000Z",
      },
      {
        id: "trx-id-2",
        accountId: "wallet-id",
        amount: 9.824690376349,
        currencyId: 29,
        transactionTypeId: 1,
        createdAt: "2026-05-13T00:00:00.000Z",
      },
    ] as GResponse200)

    expect(transactions).toHaveLength(2)
    expect(transactions[0].settlementCurrency).toBe(WalletCurrency.Usdt)
    expect(transactions[0].settlementAmount).toBe(18)
    expect(transactions[1].settlementAmount).toBe(982)
    expect(
      transactions.reduce((sum, transaction) => sum + transaction.settlementAmount, 0),
    ).toBe(1_000)
  })

  it("maps IBEX USDT send amounts to negative integer cents", () => {
    const [transaction] = toWalletTransactions([
      {
        id: "trx-id",
        accountId: "wallet-id",
        amount: 0.5,
        networkFee: 0.000001,
        currencyId: 29,
        transactionTypeId: 2,
        createdAt: "2026-05-13T00:00:00.000Z",
      },
    ] as GResponse200)

    expect(transaction.settlementCurrency).toBe(WalletCurrency.Usdt)
    expect(transaction.settlementAmount).toBe(-50)
    expect(transaction.settlementDisplayAmount).toBe("-0.5")
    expect(transaction.settlementFee).toBe(0)
  })

  it("maps IBEX crypto send transaction type to outgoing on-chain USDT", () => {
    const [transaction] = toWalletTransactions([
      {
        id: "crypto-send-trx-id",
        accountId: "wallet-id",
        amount: 2.5,
        networkFee: 0.179554,
        currencyId: 29,
        transactionTypeId: 10,
        createdAt: "2026-06-17T05:42:53.512218Z",
      },
    ] as GResponse200)

    expect(transaction.settlementCurrency).toBe(WalletCurrency.Usdt)
    expect(transaction.settlementAmount).toBe(-250)
    expect(transaction.settlementDisplayAmount).toBe("-2.5")
    expect(transaction.settlementFee).toBe(18)
    expect(transaction.settlementDisplayFee).toBe("0.179554")
    expect(transaction.initiationVia.type).toBe("onchain")
    expect(transaction.settlementVia.type).toBe("onchain")
  })

  it("maps IBEX crypto receive transaction type to incoming on-chain USDT", () => {
    const [transaction] = toWalletTransactions([
      {
        id: "crypto-receive-trx-id",
        accountId: "wallet-id",
        amount: 2.5,
        currencyId: 29,
        transactionTypeId: 9,
        createdAt: "2026-07-17T16:30:00.000Z",
      },
    ] as GResponse200)

    expect(transaction.settlementCurrency).toBe(WalletCurrency.Usdt)
    expect(transaction.settlementAmount).toBe(250)
    expect(transaction.settlementDisplayAmount).toBe("2.5")
    expect(transaction.initiationVia.type).toBe("onchain")
    expect(transaction.settlementVia.type).toBe("onchain")
  })

  it("maps IBEX taproot types to on-chain with send rendered negative", () => {
    const [received, sent] = toWalletTransactions([
      {
        id: "taproot-receive",
        accountId: "wallet-id",
        amount: 100,
        currencyId: 3,
        transactionTypeId: 11,
        createdAt: "2026-07-17T16:30:00.000Z",
      },
      {
        id: "taproot-send",
        accountId: "wallet-id",
        amount: 100,
        currencyId: 3,
        transactionTypeId: 12,
        createdAt: "2026-07-17T16:30:00.000Z",
      },
    ] as GResponse200)

    expect(received.settlementAmount).toBe(100)
    expect(received.initiationVia.type).toBe("onchain")
    expect(sent.settlementAmount).toBe(-100)
    expect(sent.settlementDisplayAmount).toBe("-100")
    expect(sent.initiationVia.type).toBe("onchain")
  })

  it("defaults omitted IBEX USDT amount and network fee to zero cents", () => {
    const [transaction] = toWalletTransactions([
      {
        id: "trx-id",
        accountId: "wallet-id",
        currencyId: 29,
        transactionTypeId: 1,
        createdAt: "2026-05-13T00:00:00.000Z",
      },
    ] as GResponse200)

    expect(transaction.settlementCurrency).toBe(WalletCurrency.Usdt)
    expect(transaction.settlementAmount).toBe(0)
    expect(transaction.settlementFee).toBe(0)
  })

  it("logs USDT conversion errors with error details", () => {
    const errorSpy = jest.spyOn(baseLogger, "error").mockImplementation()

    const [transaction] = toWalletTransactions([
      {
        id: "trx-id",
        accountId: "wallet-id",
        amount: Number.NaN,
        currencyId: 29,
        transactionTypeId: 1,
        createdAt: "2026-05-13T00:00:00.000Z",
      },
    ] as GResponse200)

    expect(transaction.settlementAmount).toBe(0)
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), amount: expect.any(Number) }),
      "Failed to parse IBEX USDT amount",
    )

    errorSpy.mockRestore()
  })

  it("keeps IBEX USD amounts in integer cents", () => {
    const [transaction] = toWalletTransactions([
      {
        id: "trx-id",
        accountId: "wallet-id",
        amount: 500,
        networkFee: 12,
        currencyId: 3,
        transactionTypeId: 1,
        createdAt: "2026-05-13T00:00:00.000Z",
      },
    ] as GResponse200)

    expect(transaction.settlementCurrency).toBe(WalletCurrency.Usd)
    expect(transaction.settlementAmount).toBe(500)
    expect(transaction.settlementFee).toBe(12)
  })

  it("excludes transactions with unknown IBEX currency ids from the list", () => {
    const errorSpy = jest.spyOn(baseLogger, "error").mockImplementation()

    const transactions = toWalletTransactions([
      {
        id: "trx-id",
        accountId: "wallet-id",
        amount: 100,
        currencyId: 999,
        transactionTypeId: 1,
        createdAt: "2026-05-13T00:00:00.000Z",
      },
    ] as GResponse200)

    expect(transactions).toHaveLength(0)
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to parse Ibex transaction currency"),
    )

    errorSpy.mockRestore()
  })

  it("maps unknown IBEX transaction type ids to intraledger with valid amounts", () => {
    const errorSpy = jest.spyOn(baseLogger, "error").mockImplementation()

    const [transaction] = toWalletTransactions([
      {
        id: "trx-id",
        accountId: "wallet-id",
        amount: 250,
        networkFee: 1,
        currencyId: 3,
        transactionTypeId: 99,
        createdAt: "2026-05-13T00:00:00.000Z",
      },
    ] as GResponse200)

    expect(transaction.settlementCurrency).toBe(WalletCurrency.Usd)
    expect(transaction.settlementAmount).toBe(250)
    expect(transaction.settlementFee).toBe(1)
    expect(transaction.initiationVia.type).toBe("intraledger")
    expect(transaction.settlementVia.type).toBe("intraledger")
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to parse Ibex transaction type"),
    )

    errorSpy.mockRestore()
  })

  it("never emits via types outside the GraphQL union members", () => {
    const resolvable = ["intraledger", "lightning", "onchain"]

    const transactions = toWalletTransactions(
      [3, 29].flatMap((currencyId) =>
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 99, undefined].map(
          (transactionTypeId, i) => ({
            id: `trx-${currencyId}-${i}`,
            accountId: "wallet-id",
            amount: 10,
            currencyId,
            transactionTypeId,
            createdAt: "2026-05-13T00:00:00.000Z",
          }),
        ),
      ) as GResponse200,
    )

    expect(transactions).toHaveLength(28)
    for (const transaction of transactions) {
      expect(resolvable).toContain(transaction.initiationVia.type)
      expect(resolvable).toContain(transaction.settlementVia.type)
    }
  })

  it("keeps IBEX bank/funding ops (5-8) on the logged intraledger fallback", () => {
    const errorSpy = jest.spyOn(baseLogger, "error").mockImplementation()

    const transactions = toWalletTransactions(
      [5, 6, 7, 8].map((transactionTypeId) => ({
        id: `trx-${transactionTypeId}`,
        accountId: "wallet-id",
        amount: 10,
        currencyId: 3,
        transactionTypeId,
        createdAt: "2026-05-13T00:00:00.000Z",
      })) as GResponse200,
    )

    expect(transactions).toHaveLength(4)
    for (const transaction of transactions) {
      expect(transaction.initiationVia.type).toBe("intraledger")
      expect(transaction.settlementVia.type).toBe("intraledger")
    }

    const fallbackLogs = errorSpy.mock.calls.filter(
      ([msg]) =>
        typeof msg === "string" && msg.includes("Failed to parse Ibex transaction type"),
    )
    expect(fallbackLogs).toHaveLength(4)
    for (const typeId of [5, 6, 7, 8]) {
      expect(
        fallbackLogs.some(([msg]) =>
          (msg as string).includes(`transactionTypeId: ${typeId}`),
        ),
      ).toBe(true)
    }

    errorSpy.mockRestore()
  })
})

describe("getTransactionsForWallets", () => {
  beforeEach(() => {
    jest.mocked(Ibex.getAccountTransactions).mockReset()
    jest.mocked(mockGetTransactionsByWalletIds).mockReset()
    resetIbexAvailability()
  })

  it("concatenates active wallet history before the legacy archive wallet history", async () => {
    const activeSettlementWallet = wallet({
      id: "33333333-3333-4333-8333-333333333333",
      currency: WalletCurrency.Usdt,
    })
    const legacyUsdWallet = wallet({
      id: "22222222-2222-4222-8222-222222222222",
      currency: WalletCurrency.Usd,
    })

    jest
      .mocked(Ibex.getAccountTransactions)
      .mockImplementation(async ({ account_id }) => {
        if (account_id === activeSettlementWallet.id) {
          return [
            {
              id: "active-newer",
              accountId: activeSettlementWallet.id,
              amount: 100,
              currencyId: 29,
              transactionTypeId: 1,
              createdAt: "2026-06-01T00:00:00.000Z",
            },
          ] as GResponse200
        }

        return [
          {
            id: "legacy-archive-older",
            accountId: legacyUsdWallet.id,
            amount: 200,
            currencyId: 3,
            transactionTypeId: 1,
            createdAt: "2026-05-01T00:00:00.000Z",
          },
        ] as GResponse200
      })

    const result = await getTransactionsForWallets({
      wallets: [activeSettlementWallet, legacyUsdWallet],
      paginationArgs: { first: 20 },
    })

    expect(Ibex.getAccountTransactions).toHaveBeenNthCalledWith(1, {
      account_id: activeSettlementWallet.id,
      limit: 20,
      page: 0,
      sort: "settledAt",
    })
    expect(Ibex.getAccountTransactions).toHaveBeenNthCalledWith(2, {
      account_id: legacyUsdWallet.id,
      limit: 20,
      page: 0,
      sort: "settledAt",
    })
    expect(result.result?.slice.map((transaction) => transaction.id)).toEqual([
      "active-newer",
      "legacy-archive-older",
    ])
  })

  // Circuit already open (see @services/ibex/availability): the whole page
  // comes from the ledger in one read, so a BTC history still renders while
  // the cash rail is down — and nothing pays the IBEX timeout at all.
  it("serves confirmed ledger rows while IBEX is unavailable", async () => {
    markIbexUnavailable()
    mockGetTransactionsByWalletIds.mockResolvedValue({
      slice: [ledgerTxn("ledger-txn-1")],
      total: 7,
    })

    const btcWallet = wallet({
      id: "33333333-3333-4333-8333-333333333333",
      currency: WalletCurrency.Btc,
    })
    const result = await getTransactionsForWallets({
      wallets: [btcWallet],
      paginationArgs: { first: 20 },
    })

    expect(Ibex.getAccountTransactions).not.toHaveBeenCalled()
    expect(mockGetTransactionsByWalletIds).toHaveBeenCalledWith({
      walletIds: [btcWallet.id],
      paginationArgs: { first: 20 },
    })
    expect(result.error).toBeUndefined()
    expect(result.result?.total).toBe(7)
    expect(result.result?.slice.map((transaction) => transaction.id)).toEqual([
      "ledger-txn-1",
    ])
    // Rows are translated into wallet transactions, not handed over raw.
    expect(result.result?.slice[0].settlementAmount).toBe(1000)
    expect(result.result?.slice[0].settlementCurrency).toBe(WalletCurrency.Btc)
  })

  it("reports a failure when neither IBEX nor the ledger has rows", async () => {
    markIbexUnavailable()
    mockGetTransactionsByWalletIds.mockResolvedValue(new Error("mongo down"))

    const result = await getTransactionsForWallets({
      wallets: [
        wallet({
          id: "33333333-3333-4333-8333-333333333333",
          currency: WalletCurrency.Btc,
        }),
      ],
    })

    expect(result.result).toBeNull()
    expect(result.error).toBeInstanceOf(Error)
  })

  // One cash wallet refusing to answer must not hide the rows that did come
  // back: the page is rebuilt from the ledger (one consistent source rather
  // than a half-filled mix) and still renders.
  it("keeps a page intact when one wallet's IBEX call fails", async () => {
    const btcWallet = wallet({
      id: "11111111-1111-4111-8111-111111111111",
      currency: WalletCurrency.Btc,
    })
    const cashWallet = wallet({
      id: "22222222-2222-4222-8222-222222222222",
      currency: WalletCurrency.Usd,
    })
    jest
      .mocked(Ibex.getAccountTransactions)
      .mockImplementation(async ({ account_id }) => {
        if (account_id === cashWallet.id) return new IbexError(new Error("boom"))
        return [
          {
            id: "ibex-row",
            accountId: btcWallet.id,
            amount: 1,
            currencyId: 3,
            transactionTypeId: 1,
            createdAt: "2026-06-01T00:00:00.000Z",
          },
        ] as GResponse200
      })
    mockGetTransactionsByWalletIds.mockResolvedValue({
      slice: [ledgerTxn("ledger-txn-1")],
      total: 1,
    })

    const result = await getTransactionsForWallets({
      wallets: [btcWallet, cashWallet],
      paginationArgs: { first: 20 },
    })

    expect(result.error).toBeUndefined()
    expect(result.result?.slice.map((transaction) => transaction.id)).toEqual([
      "ledger-txn-1",
    ])
    expect(mockGetTransactionsByWalletIds).toHaveBeenCalledWith({
      walletIds: [btcWallet.id, cashWallet.id],
      paginationArgs: { first: 20 },
    })
  })
})
