jest.mock("@services/alerts", () => ({ alertBridge: jest.fn() }))

/**
 * Unit tests for Bridge↔IBEX reconciliation
 * Covers reconcileByTxHash (real-time) and reconcileBridgeAndIbexDeposits (batch)
 */

// ── Mocks (must be before imports) ───────────────────────────────────────────

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock("@services/mongoose/schema", () => ({
  BridgeDeposits: { findOne: jest.fn(), find: jest.fn() },
  BridgeWithdrawal: { find: jest.fn() },
  IbexCryptoReceive: { findOne: jest.fn() },
}))

jest.mock("@services/mongoose/bridge-accounts", () => ({
  updateWithdrawalStatus: jest.fn(),
  noteWithdrawalCryptoSendReviewed: jest.fn(),
}))

jest.mock("@services/bridge/client", () => ({
  __esModule: true,
  default: {
    deleteTransfer: jest.fn(),
    getTransfer: jest.fn(),
  },
}))

jest.mock("@services/mongoose/ibex-crypto-receive-log", () => ({
  findIbexCryptoReceivesSince: jest.fn(),
}))

jest.mock("@services/mongoose/bridge-reconciliation-orphan", () => ({
  upsertBridgeReconciliationOrphan: jest.fn(),
  resolveOrphansByTxHash: jest.fn(),
}))

jest.mock("@services/pubsub", () => ({
  PubSubService: jest.fn(),
}))

jest.mock("@domain/pubsub", () => ({
  PubSubDefaultTriggers: {
    BridgeReconciliationUpdate: "BRIDGE_RECONCILIATION_UPDATE",
  },
}))

jest.mock("@services/alerts/ibex-bridge-movement", () => ({
  alertIbexReconciliationOrphan: jest.fn(),
  alertIbexReconciliationFailed: jest.fn(),
}))

import {
  BridgeDeposits,
  BridgeWithdrawal,
  IbexCryptoReceive,
} from "@services/mongoose/schema"
import { findIbexCryptoReceivesSince } from "@services/mongoose/ibex-crypto-receive-log"
import * as BridgeAccountsRepo from "@services/mongoose/bridge-accounts"
import BridgeApiClient from "@services/bridge/client"
import {
  upsertBridgeReconciliationOrphan,
  resolveOrphansByTxHash,
} from "@services/mongoose/bridge-reconciliation-orphan"
import { PubSubService } from "@services/pubsub"
import { alertIbexReconciliationOrphan } from "@services/alerts/ibex-bridge-movement"
import {
  reconcileByTxHash,
  reconcileBridgeAndIbexDeposits,
  reconcileBridgeAndIbexWithdrawals,
} from "@services/bridge/reconciliation"

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TX_HASH = "0xABC123def456"
const NORM_HASH = TX_HASH.toLowerCase()

const BRIDGE_DEPOSIT = {
  eventId: "evt_001",
  transferId: "tr_001",
  customerId: "cust_001",
  amount: "100",
  currency: "usdt",
  destinationTxHash: NORM_HASH,
  state: "payment_processed",
  createdAt: new Date("2026-01-01T12:00:00Z"),
}

const IBEX_RECEIVE = {
  txHash: NORM_HASH,
  address: "0xdeadbeef",
  amount: "100",
  currency: "USDT",
  network: "tron",
  accountId: "acc_001",
  receivedAt: new Date("2026-01-01T12:00:02Z"),
}

const BRIDGE_WITHDRAWAL_USDT_SENT = {
  _id: "withdrawal_001",
  accountId: "acct_001",
  bridgeTransferId: "tr_withdrawal_001",
  bridgeDepositAddress: "0xbridge",
  ibexPayoutId: "ibex_payout_001",
  amount: "25.00",
  currency: "usdt",
  status: "usdt_sent",
  createdAt: new Date("2026-01-01T12:00:00Z"),
  updatedAt: new Date("2026-01-01T12:00:01Z"),
}

const BRIDGE_WITHDRAWAL_SEND_FAILED = {
  ...BRIDGE_WITHDRAWAL_USDT_SENT,
  _id: "withdrawal_002",
  bridgeTransferId: "tr_withdrawal_002",
  ibexPayoutId: undefined,
  status: "send_failed",
  failureReason: "ibex unavailable",
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const mockPublish = jest.fn()

const makeLeanQuery = (result: unknown) => {
  const query = {
    collation: jest.fn(() => query),
    lean: () => ({ exec: () => Promise.resolve(result) }),
  }
  return query
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(PubSubService as jest.Mock).mockReturnValue({ publish: mockPublish })
  ;(resolveOrphansByTxHash as jest.Mock).mockResolvedValue({ resolvedCount: 0 })
  ;(upsertBridgeReconciliationOrphan as jest.Mock).mockResolvedValue({ id: "orphan_001" })
  ;(BridgeApiClient.deleteTransfer as jest.Mock).mockResolvedValue({ id: "tr_deleted" })
  ;(BridgeApiClient.getTransfer as jest.Mock).mockResolvedValue({
    id: "tr_withdrawal_001",
    state: "awaiting_funds",
  })
  ;(BridgeAccountsRepo.updateWithdrawalStatus as jest.Mock).mockResolvedValue({
    ...BRIDGE_WITHDRAWAL_USDT_SENT,
    status: "completed",
  })
})

// ── reconcileByTxHash ─────────────────────────────────────────────────────────

describe("reconcileByTxHash", () => {
  describe("both sides found → matched", () => {
    beforeEach(() => {
      ;(BridgeDeposits.findOne as jest.Mock).mockReturnValue(
        makeLeanQuery(BRIDGE_DEPOSIT),
      )
      ;(IbexCryptoReceive.findOne as jest.Mock).mockReturnValue(
        makeLeanQuery(IBEX_RECEIVE),
      )
    })

    it("returns status matched", async () => {
      const result = await reconcileByTxHash({ txHash: TX_HASH })
      expect(result).not.toBeInstanceOf(Error)
      if (result instanceof Error) return
      expect(result.status).toBe("matched")
      expect(result.txHash).toBe(NORM_HASH)
    })

    it("calls resolveOrphansByTxHash with normalized hash", async () => {
      await reconcileByTxHash({ txHash: TX_HASH })
      expect(resolveOrphansByTxHash).toHaveBeenCalledWith(NORM_HASH)
    })

    it("does NOT call upsertBridgeReconciliationOrphan", async () => {
      await reconcileByTxHash({ txHash: TX_HASH })
      expect(upsertBridgeReconciliationOrphan).not.toHaveBeenCalled()
    })

    it("publishes a matched event to PubSub", async () => {
      await reconcileByTxHash({ txHash: TX_HASH })
      expect(mockPublish).toHaveBeenCalledWith(
        expect.objectContaining({
          trigger: "BRIDGE_RECONCILIATION_UPDATE",
          payload: expect.objectContaining({
            status: "matched",
            txHash: NORM_HASH,
            transferId: BRIDGE_DEPOSIT.transferId,
            customerId: BRIDGE_DEPOSIT.customerId,
            amount: BRIDGE_DEPOSIT.amount,
          }),
        }),
      )
    })

    it("normalizes txHash to lowercase before querying and returning", async () => {
      const result = await reconcileByTxHash({ txHash: "0XABC123DEF456" })
      expect(result).not.toBeInstanceOf(Error)
      if (result instanceof Error) return
      expect(result.txHash).toBe(NORM_HASH)
      const [bridgeCall] = (BridgeDeposits.findOne as jest.Mock).mock.calls
      expect(bridgeCall[0].destinationTxHash).toEqual({ $eq: NORM_HASH })
    })
  })

  describe("only Bridge found → bridge_without_ibex", () => {
    beforeEach(() => {
      ;(BridgeDeposits.findOne as jest.Mock).mockReturnValue(
        makeLeanQuery(BRIDGE_DEPOSIT),
      )
      ;(IbexCryptoReceive.findOne as jest.Mock).mockReturnValue(makeLeanQuery(null))
    })

    it("returns status unmatched with correct orphanType", async () => {
      const result = await reconcileByTxHash({ txHash: TX_HASH })
      expect(result).not.toBeInstanceOf(Error)
      if (result instanceof Error) return
      expect(result.status).toBe("unmatched")
      expect(result.orphanType).toBe("bridge_without_ibex")
    })

    it("does NOT call resolveOrphansByTxHash", async () => {
      await reconcileByTxHash({ txHash: TX_HASH })
      expect(resolveOrphansByTxHash).not.toHaveBeenCalled()
    })

    it("upserts orphan with key bridge:{hash}", async () => {
      await reconcileByTxHash({ txHash: TX_HASH })
      expect(upsertBridgeReconciliationOrphan).toHaveBeenCalledWith(
        expect.objectContaining({
          orphanKey: `bridge:${NORM_HASH}`,
          orphanType: "bridge_without_ibex",
          txHash: NORM_HASH,
          transferId: BRIDGE_DEPOSIT.transferId,
          customerId: BRIDGE_DEPOSIT.customerId,
        }),
      )
    })

    it("publishes an unmatched event to PubSub", async () => {
      await reconcileByTxHash({ txHash: TX_HASH })
      expect(mockPublish).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            status: "unmatched",
            orphanType: "bridge_without_ibex",
          }),
        }),
      )
    })

    it("alerts ops when Bridge has no matching IBEX receive", async () => {
      await reconcileByTxHash({ txHash: TX_HASH })
      expect(alertIbexReconciliationOrphan).toHaveBeenCalledWith(
        expect.objectContaining({
          orphanType: "bridge_without_ibex",
          txHash: NORM_HASH,
          transferId: BRIDGE_DEPOSIT.transferId,
        }),
      )
    })
  })

  describe("only IBEX found → ibex_without_bridge", () => {
    beforeEach(() => {
      ;(BridgeDeposits.findOne as jest.Mock).mockReturnValue(makeLeanQuery(null))
      ;(IbexCryptoReceive.findOne as jest.Mock).mockReturnValue(
        makeLeanQuery(IBEX_RECEIVE),
      )
    })

    it("returns status unmatched with correct orphanType", async () => {
      const result = await reconcileByTxHash({ txHash: TX_HASH })
      expect(result).not.toBeInstanceOf(Error)
      if (result instanceof Error) return
      expect(result.status).toBe("unmatched")
      expect(result.orphanType).toBe("ibex_without_bridge")
    })

    it("upserts orphan with key ibex:{hash}", async () => {
      await reconcileByTxHash({ txHash: TX_HASH })
      expect(upsertBridgeReconciliationOrphan).toHaveBeenCalledWith(
        expect.objectContaining({
          orphanKey: `ibex:${NORM_HASH}`,
          orphanType: "ibex_without_bridge",
          txHash: NORM_HASH,
        }),
      )
    })

    it("alerts ops when IBEX has no matching Bridge deposit", async () => {
      await reconcileByTxHash({ txHash: TX_HASH })
      expect(alertIbexReconciliationOrphan).toHaveBeenCalledWith(
        expect.objectContaining({
          orphanType: "ibex_without_bridge",
          txHash: NORM_HASH,
        }),
      )
    })
  })

  describe("self-healing: second call with both sides resolves orphan", () => {
    it("resolves orphan when called again after missing side arrives", async () => {
      // First call: only Bridge
      ;(BridgeDeposits.findOne as jest.Mock).mockReturnValue(
        makeLeanQuery(BRIDGE_DEPOSIT),
      )
      ;(IbexCryptoReceive.findOne as jest.Mock).mockReturnValue(makeLeanQuery(null))
      await reconcileByTxHash({ txHash: TX_HASH })
      expect(upsertBridgeReconciliationOrphan).toHaveBeenCalledTimes(1)

      jest.clearAllMocks()
      ;(PubSubService as jest.Mock).mockReturnValue({ publish: mockPublish })
      ;(resolveOrphansByTxHash as jest.Mock).mockResolvedValue({ resolvedCount: 1 })

      // Second call: both sides present (IBEX webhook arrived)
      ;(BridgeDeposits.findOne as jest.Mock).mockReturnValue(
        makeLeanQuery(BRIDGE_DEPOSIT),
      )
      ;(IbexCryptoReceive.findOne as jest.Mock).mockReturnValue(
        makeLeanQuery(IBEX_RECEIVE),
      )
      const result = await reconcileByTxHash({ txHash: TX_HASH })

      expect(result).not.toBeInstanceOf(Error)
      if (result instanceof Error) return
      expect(result.status).toBe("matched")
      expect(resolveOrphansByTxHash).toHaveBeenCalledWith(NORM_HASH)
      expect(upsertBridgeReconciliationOrphan).not.toHaveBeenCalled()
    })
  })

  describe("Bridge query uses payment_processed state filter", () => {
    it("passes state: payment_processed to BridgeDeposits.findOne", async () => {
      ;(BridgeDeposits.findOne as jest.Mock).mockReturnValue(makeLeanQuery(null))
      ;(IbexCryptoReceive.findOne as jest.Mock).mockReturnValue(makeLeanQuery(null))
      await reconcileByTxHash({ txHash: TX_HASH })
      expect(BridgeDeposits.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ state: "payment_processed" }),
      )
    })
  })
})

// ── reconcileBridgeAndIbexDeposits (batch) ────────────────────────────────────

describe("reconcileBridgeAndIbexDeposits", () => {
  const makeBridgeFind = (deposits: unknown[]) => ({
    lean: () => ({ exec: () => Promise.resolve(deposits) }),
  })

  describe("all deposits matched", () => {
    it("returns zero orphans when every Bridge deposit has a matching IBEX receive", async () => {
      ;(BridgeDeposits.find as jest.Mock).mockReturnValue(
        makeBridgeFind([BRIDGE_DEPOSIT]),
      )
      ;(findIbexCryptoReceivesSince as jest.Mock).mockResolvedValue([IBEX_RECEIVE])

      const result = await reconcileBridgeAndIbexDeposits()
      expect(result).not.toBeInstanceOf(Error)
      if (result instanceof Error) return
      expect(result.scannedBridge).toBe(1)
      expect(result.scannedIbex).toBe(1)
      expect(result.bridgeWithoutIbex).toBe(0)
      expect(result.ibexWithoutBridge).toBe(0)
      expect(upsertBridgeReconciliationOrphan).not.toHaveBeenCalled()
    })
  })

  describe("Bridge deposit with no matching IBEX receive", () => {
    it("flags as bridge_without_ibex orphan", async () => {
      ;(BridgeDeposits.find as jest.Mock).mockReturnValue(
        makeBridgeFind([BRIDGE_DEPOSIT]),
      )
      ;(findIbexCryptoReceivesSince as jest.Mock).mockResolvedValue([])

      const result = await reconcileBridgeAndIbexDeposits()
      expect(result).not.toBeInstanceOf(Error)
      if (result instanceof Error) return
      expect(result.bridgeWithoutIbex).toBe(1)
      expect(upsertBridgeReconciliationOrphan).toHaveBeenCalledWith(
        expect.objectContaining({
          orphanKey: `bridge:${NORM_HASH}`,
          orphanType: "bridge_without_ibex",
          txHash: NORM_HASH,
          transferId: BRIDGE_DEPOSIT.transferId,
        }),
      )
    })
  })

  describe("Bridge deposit with no destinationTxHash", () => {
    it("flags as bridge-no-tx:{transferId} orphan", async () => {
      const depositNoHash = { ...BRIDGE_DEPOSIT, destinationTxHash: undefined }
      ;(BridgeDeposits.find as jest.Mock).mockReturnValue(makeBridgeFind([depositNoHash]))
      ;(findIbexCryptoReceivesSince as jest.Mock).mockResolvedValue([])

      const result = await reconcileBridgeAndIbexDeposits()
      expect(result).not.toBeInstanceOf(Error)
      if (result instanceof Error) return
      expect(result.bridgeWithoutIbex).toBe(1)
      expect(upsertBridgeReconciliationOrphan).toHaveBeenCalledWith(
        expect.objectContaining({
          orphanKey: `bridge-no-tx:${BRIDGE_DEPOSIT.transferId}`,
          orphanType: "bridge_without_ibex",
        }),
      )
    })
  })

  describe("IBEX receive with no matching Bridge deposit", () => {
    it("flags as ibex_without_bridge orphan", async () => {
      ;(BridgeDeposits.find as jest.Mock).mockReturnValue(makeBridgeFind([]))
      ;(findIbexCryptoReceivesSince as jest.Mock).mockResolvedValue([IBEX_RECEIVE])

      const result = await reconcileBridgeAndIbexDeposits()
      expect(result).not.toBeInstanceOf(Error)
      if (result instanceof Error) return
      expect(result.ibexWithoutBridge).toBe(1)
      expect(upsertBridgeReconciliationOrphan).toHaveBeenCalledWith(
        expect.objectContaining({
          orphanKey: `ibex:${NORM_HASH}`,
          orphanType: "ibex_without_bridge",
          txHash: IBEX_RECEIVE.txHash,
        }),
      )
    })
  })

  describe("batch uses payment_processed state filter", () => {
    it("passes state: payment_processed to BridgeDeposits.find", async () => {
      ;(BridgeDeposits.find as jest.Mock).mockReturnValue(makeBridgeFind([]))
      ;(findIbexCryptoReceivesSince as jest.Mock).mockResolvedValue([])

      await reconcileBridgeAndIbexDeposits()
      expect(BridgeDeposits.find).toHaveBeenCalledWith(
        expect.objectContaining({ state: "payment_processed" }),
      )
    })
  })

  describe("mixed scenario", () => {
    it("counts matched and unmatched independently", async () => {
      const deposit2 = {
        ...BRIDGE_DEPOSIT,
        transferId: "tr_002",
        destinationTxHash: "0xother",
      }
      const ibex2 = { ...IBEX_RECEIVE, txHash: "0xorphan_ibex" }

      ;(BridgeDeposits.find as jest.Mock).mockReturnValue(
        makeBridgeFind([BRIDGE_DEPOSIT, deposit2]),
      )
      ;(findIbexCryptoReceivesSince as jest.Mock).mockResolvedValue([IBEX_RECEIVE, ibex2])

      const result = await reconcileBridgeAndIbexDeposits()
      expect(result).not.toBeInstanceOf(Error)
      if (result instanceof Error) return
      // BRIDGE_DEPOSIT ↔ IBEX_RECEIVE match (same hash)
      // deposit2 has no ibex → bridge_without_ibex
      // ibex2 has no bridge → ibex_without_bridge
      expect(result.scannedBridge).toBe(2)
      expect(result.scannedIbex).toBe(2)
      expect(result.bridgeWithoutIbex).toBe(1)
      expect(result.ibexWithoutBridge).toBe(1)
      expect(upsertBridgeReconciliationOrphan).toHaveBeenCalledTimes(2)
    })
  })

  describe("error handling", () => {
    it("returns an Error when findIbexCryptoReceivesSince fails", async () => {
      ;(BridgeDeposits.find as jest.Mock).mockReturnValue(makeBridgeFind([]))
      ;(findIbexCryptoReceivesSince as jest.Mock).mockResolvedValue(
        new Error("mongo connection lost"),
      )

      const result = await reconcileBridgeAndIbexDeposits()
      expect(result).toBeInstanceOf(Error)
    })
  })
})

describe("reconcileBridgeAndIbexWithdrawals", () => {
  const makeWithdrawalFind = (withdrawals: unknown[]) => {
    const query = {
      sort: jest.fn(() => query),
      limit: jest.fn(() => query),
      maxTimeMS: jest.fn(() => query),
      lean: () => ({ exec: () => Promise.resolve(withdrawals) }),
    }
    return query
  }

  it("cancels Bridge transfers only with explicit pre-dispatch failure proof", async () => {
    ;(BridgeWithdrawal.find as jest.Mock).mockReturnValue(
      makeWithdrawalFind([
        { ...BRIDGE_WITHDRAWAL_SEND_FAILED, cryptoSendState: "not_dispatched" },
      ]),
    )

    const result = await reconcileBridgeAndIbexWithdrawals()

    expect(result).not.toBeInstanceOf(Error)
    if (result instanceof Error) return
    expect(BridgeApiClient.deleteTransfer).toHaveBeenCalledWith("tr_withdrawal_002")
    expect(result.cancelledSendFailedTransfers).toBe(1)
    expect(upsertBridgeReconciliationOrphan).not.toHaveBeenCalled()
  })

  it.each([
    { status: "send_failed" },
    {
      status: "send_failed",
      cryptoSendState: "not_dispatched",
      cryptoSendAttemptId: "attempt",
    },
    { status: "send_unknown", cryptoSendAttemptId: "attempt" },
    { status: "submitted" },
  ])("never cancels, retries or marks paid for uncertain row %p", async (fields) => {
    ;(BridgeWithdrawal.find as jest.Mock).mockReturnValue(
      makeWithdrawalFind([
        {
          ...BRIDGE_WITHDRAWAL_SEND_FAILED,
          ...fields,
          updatedAt: new Date("2000-01-01"),
          failureReason: "PRIVATE_PROVIDER_BODY",
        },
      ]),
    )
    const result = await reconcileBridgeAndIbexWithdrawals()
    expect(result).not.toBeInstanceOf(Error)
    expect(BridgeApiClient.deleteTransfer).not.toHaveBeenCalled()
    expect(BridgeApiClient.getTransfer).toHaveBeenCalledTimes(1)
    expect(BridgeAccountsRepo.updateWithdrawalStatus).not.toHaveBeenCalled()
    expect(upsertBridgeReconciliationOrphan).not.toHaveBeenCalled()
  })

  it("does not age unresolved rows out of the scanner", async () => {
    ;(BridgeWithdrawal.find as jest.Mock).mockReturnValue(makeWithdrawalFind([]))
    await reconcileBridgeAndIbexWithdrawals()
    const query = (BridgeWithdrawal.find as jest.Mock).mock.calls[0][0]
    expect(query).toMatchObject({
      $or: expect.arrayContaining([
        { status: { $in: ["send_unknown", "send_failed", "usdt_sent"] } },
      ]),
    })
    expect(query).not.toHaveProperty("updatedAt")
  })

  it("clears uncertainty only for an exact Bridge payment_processed receipt", async () => {
    ;(BridgeWithdrawal.find as jest.Mock).mockReturnValue(
      makeWithdrawalFind([{ ...BRIDGE_WITHDRAWAL_SEND_FAILED, status: "send_unknown" }]),
    )
    ;(BridgeApiClient.getTransfer as jest.Mock).mockResolvedValue({
      id: "tr_withdrawal_002",
      state: "payment_processed",
    })
    const result = await reconcileBridgeAndIbexWithdrawals()
    expect(result).toMatchObject({ finalizedCompletedTransfers: 1 })
    expect(BridgeAccountsRepo.updateWithdrawalStatus).toHaveBeenCalledWith(
      "tr_withdrawal_002",
      "completed",
      undefined,
      "payment_processed",
    )
    expect(BridgeApiClient.deleteTransfer).not.toHaveBeenCalled()
  })

  it("never resolves an unknown send from a foreign transfer receipt", async () => {
    ;(BridgeWithdrawal.find as jest.Mock).mockReturnValue(
      makeWithdrawalFind([{ ...BRIDGE_WITHDRAWAL_SEND_FAILED, status: "send_unknown" }]),
    )
    ;(BridgeApiClient.getTransfer as jest.Mock).mockResolvedValue({
      id: "foreign-transfer",
      state: "payment_processed",
    })
    expect(await reconcileBridgeAndIbexWithdrawals()).toMatchObject({
      finalizedCompletedTransfers: 0,
      unresolvedSendOutcomes: 1,
    })
    expect(BridgeAccountsRepo.updateWithdrawalStatus).not.toHaveBeenCalled()
    expect(BridgeApiClient.deleteTransfer).not.toHaveBeenCalled()
    expect(BridgeAccountsRepo.noteWithdrawalCryptoSendReviewed).toHaveBeenCalledWith(
      "withdrawal_002",
    )
  })

  it("bounds the review batch and rotates review timestamps without aging uncertainty out", async () => {
    const query = makeWithdrawalFind([
      { ...BRIDGE_WITHDRAWAL_SEND_FAILED, status: "send_unknown" },
    ])
    ;(BridgeWithdrawal.find as jest.Mock).mockReturnValue(query)
    await reconcileBridgeAndIbexWithdrawals()
    expect(query.sort).toHaveBeenCalledWith({ cryptoSendReviewedAt: 1, _id: 1 })
    expect(query.limit).toHaveBeenCalledWith(100)
    expect(query.maxTimeMS).toHaveBeenCalledWith(5_000)
    expect(BridgeAccountsRepo.noteWithdrawalCryptoSendReviewed).toHaveBeenCalledWith(
      "withdrawal_002",
    )
  })

  it("self-heals a sent withdrawal when Bridge already reports payment_processed", async () => {
    ;(BridgeWithdrawal.find as jest.Mock).mockReturnValue(
      makeWithdrawalFind([BRIDGE_WITHDRAWAL_USDT_SENT]),
    )
    ;(BridgeApiClient.getTransfer as jest.Mock).mockResolvedValue({
      id: "tr_withdrawal_001",
      state: "payment_processed",
    })

    const result = await reconcileBridgeAndIbexWithdrawals()

    expect(result).not.toBeInstanceOf(Error)
    if (result instanceof Error) return
    expect(BridgeAccountsRepo.updateWithdrawalStatus).toHaveBeenCalledWith(
      "tr_withdrawal_001",
      "completed",
    )
    expect(result.finalizedCompletedTransfers).toBe(1)
  })

  it("alerts when IBEX sent funds but Bridge is terminally failed", async () => {
    ;(BridgeWithdrawal.find as jest.Mock).mockReturnValue(
      makeWithdrawalFind([BRIDGE_WITHDRAWAL_USDT_SENT]),
    )
    ;(BridgeApiClient.getTransfer as jest.Mock).mockResolvedValue({
      id: "tr_withdrawal_001",
      state: "error",
      on_behalf_of: "cust_001",
    })

    const result = await reconcileBridgeAndIbexWithdrawals()

    expect(result).not.toBeInstanceOf(Error)
    if (result instanceof Error) return
    expect(result.ibexSendWithoutBridgeSettlement).toBe(1)
    expect(upsertBridgeReconciliationOrphan).toHaveBeenCalledWith(
      expect.objectContaining({
        orphanKey: "withdrawal-ibex-sent:tr_withdrawal_001",
        orphanType: "ibex_send_without_bridge_settlement",
        transferId: "tr_withdrawal_001",
      }),
    )
    expect(alertIbexReconciliationOrphan).toHaveBeenCalledWith(
      expect.objectContaining({
        orphanType: "ibex_send_without_bridge_settlement",
        transferId: "tr_withdrawal_001",
      }),
    )
  })
})
