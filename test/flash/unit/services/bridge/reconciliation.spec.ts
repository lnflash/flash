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
  markSendFailedTransferCancelled: jest.fn(),
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
  ;(upsertBridgeReconciliationOrphan as jest.Mock).mockResolvedValue({
    id: "orphan_001",
    created: true,
  })
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

  beforeEach(() => {
    // No deposit outside the window unless a test says so.
    ;(BridgeDeposits.findOne as jest.Mock).mockReturnValue(makeLeanQuery(null))
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

  // ENG-891: the check runs hourly over a week, so it alerts once per orphan
  // and leaves a young deposit to the matcher.
  describe("hourly use", () => {
    it("alerts on a new orphan", async () => {
      ;(BridgeDeposits.find as jest.Mock).mockReturnValue(
        makeBridgeFind([BRIDGE_DEPOSIT]),
      )
      ;(findIbexCryptoReceivesSince as jest.Mock).mockResolvedValue([])

      await reconcileBridgeAndIbexDeposits()

      expect(alertIbexReconciliationOrphan).toHaveBeenCalledWith(
        expect.objectContaining({ orphanType: "bridge_without_ibex", txHash: NORM_HASH }),
      )
    })

    it("does not alert again for an orphan already on file", async () => {
      ;(upsertBridgeReconciliationOrphan as jest.Mock).mockResolvedValue({
        id: "orphan_001",
        created: false,
      })
      const noHash = {
        ...BRIDGE_DEPOSIT,
        transferId: "tr_nohash",
        destinationTxHash: undefined,
      }
      ;(BridgeDeposits.find as jest.Mock).mockReturnValue(
        makeBridgeFind([BRIDGE_DEPOSIT, noHash]),
      )
      ;(findIbexCryptoReceivesSince as jest.Mock).mockResolvedValue([
        { ...IBEX_RECEIVE, txHash: "0xorphan_ibex" },
      ])

      const result = await reconcileBridgeAndIbexDeposits()

      expect(upsertBridgeReconciliationOrphan).toHaveBeenCalledTimes(3)
      expect(alertIbexReconciliationOrphan).not.toHaveBeenCalled()
      expect(result).toEqual(
        expect.objectContaining({ bridgeWithoutIbex: 2, ibexWithoutBridge: 1 }),
      )
    })

    it("does not flag a receive whose Bridge deposit is older than the window", async () => {
      // The matcher recorded a six-day-old deposit; the receive is stamped now.
      ;(BridgeDeposits.find as jest.Mock).mockReturnValue(makeBridgeFind([]))
      ;(BridgeDeposits.findOne as jest.Mock).mockReturnValue(
        makeLeanQuery(BRIDGE_DEPOSIT),
      )
      ;(findIbexCryptoReceivesSince as jest.Mock).mockResolvedValue([IBEX_RECEIVE])

      const result = await reconcileBridgeAndIbexDeposits()

      expect(result).toEqual(expect.objectContaining({ ibexWithoutBridge: 0 }))
      expect(BridgeDeposits.findOne).toHaveBeenCalledWith({
        destinationTxHash: { $eq: NORM_HASH },
        state: "payment_processed",
      })
      expect(upsertBridgeReconciliationOrphan).not.toHaveBeenCalled()
    })

    it("still alerts when the orphan could not be stored", async () => {
      ;(upsertBridgeReconciliationOrphan as jest.Mock).mockResolvedValue(
        new Error("mongo"),
      )
      ;(BridgeDeposits.find as jest.Mock).mockReturnValue(
        makeBridgeFind([BRIDGE_DEPOSIT]),
      )
      ;(findIbexCryptoReceivesSince as jest.Mock).mockResolvedValue([])

      await reconcileBridgeAndIbexDeposits()

      expect(alertIbexReconciliationOrphan).toHaveBeenCalledTimes(1)
    })

    it("leaves a deposit younger than minAgeMs alone, and still pairs its IBEX receive", async () => {
      const young = { ...BRIDGE_DEPOSIT, createdAt: new Date() }
      const youngUnmatched = {
        ...BRIDGE_DEPOSIT,
        transferId: "tr_young",
        destinationTxHash: "0xyoung",
        createdAt: new Date(),
      }
      ;(BridgeDeposits.find as jest.Mock).mockReturnValue(
        makeBridgeFind([young, youngUnmatched]),
      )
      ;(findIbexCryptoReceivesSince as jest.Mock).mockResolvedValue([IBEX_RECEIVE])

      const result = await reconcileBridgeAndIbexDeposits({
        windowMs: 7 * 24 * 60 * 60 * 1000,
        minAgeMs: 6 * 60 * 60 * 1000,
      })

      expect(result).toEqual(
        expect.objectContaining({ bridgeWithoutIbex: 0, ibexWithoutBridge: 0 }),
      )
      expect(upsertBridgeReconciliationOrphan).not.toHaveBeenCalled()
      expect(alertIbexReconciliationOrphan).not.toHaveBeenCalled()
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
  const makeWithdrawalFind = (withdrawals: unknown[]) => ({
    lean: () => ({ exec: () => Promise.resolve(withdrawals) }),
  })

  it("cancels Bridge transfers when IBEX crypto send failed", async () => {
    ;(BridgeWithdrawal.find as jest.Mock).mockReturnValue(
      makeWithdrawalFind([BRIDGE_WITHDRAWAL_SEND_FAILED]),
    )

    const result = await reconcileBridgeAndIbexWithdrawals()

    expect(result).not.toBeInstanceOf(Error)
    if (result instanceof Error) return
    expect(BridgeApiClient.deleteTransfer).toHaveBeenCalledWith("tr_withdrawal_002")
    expect(result.cancelledSendFailedTransfers).toBe(1)
    expect(upsertBridgeReconciliationOrphan).not.toHaveBeenCalled()
    // ENG-891: recorded, so the hourly check never deletes it again.
    expect(BridgeAccountsRepo.markSendFailedTransferCancelled).toHaveBeenCalledWith(
      "tr_withdrawal_002",
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

  // ENG-891: the check runs hourly over 30 days instead of daily over 15
  // minutes, so it must not repeat a delete or an alert.
  describe("hourly use", () => {
    const HOUR = 60 * 60 * 1000

    beforeEach(() => {
      ;(
        BridgeAccountsRepo.markSendFailedTransferCancelled as jest.Mock
      ).mockResolvedValue(true)
      ;(BridgeApiClient.deleteTransfer as jest.Mock).mockResolvedValue({ id: "tr" })
    })

    it("reads only in-flight withdrawals whose transfer is not yet cancelled", async () => {
      ;(BridgeWithdrawal.find as jest.Mock).mockReturnValue(makeWithdrawalFind([]))

      await reconcileBridgeAndIbexWithdrawals({ windowMs: 30 * 24 * HOUR })

      expect(BridgeWithdrawal.find).toHaveBeenCalledWith(
        expect.objectContaining({
          status: { $in: ["usdt_sent", "send_failed"] },
          bridgeTransferId: { $exists: true },
          bridgeTransferCancelledAt: { $exists: false },
        }),
      )
    })

    it("counts a transfer Bridge already shows canceled as cancelled, without an orphan", async () => {
      ;(BridgeWithdrawal.find as jest.Mock).mockReturnValue(
        makeWithdrawalFind([BRIDGE_WITHDRAWAL_SEND_FAILED]),
      )
      ;(BridgeApiClient.deleteTransfer as jest.Mock).mockRejectedValue(
        new Error("Bridge 400: transfer cannot be deleted"),
      )
      ;(BridgeApiClient.getTransfer as jest.Mock).mockResolvedValue({
        id: "tr_withdrawal_002",
        state: "canceled",
      })

      const result = await reconcileBridgeAndIbexWithdrawals()

      expect(result).toEqual(
        expect.objectContaining({
          cancelledSendFailedTransfers: 1,
          bridgeTransferWithoutIbexSend: 0,
        }),
      )
      expect(BridgeAccountsRepo.markSendFailedTransferCancelled).toHaveBeenCalledWith(
        "tr_withdrawal_002",
      )
      expect(upsertBridgeReconciliationOrphan).not.toHaveBeenCalled()
      expect(alertIbexReconciliationOrphan).not.toHaveBeenCalled()
    })

    it("files an orphan when the delete fails and Bridge still holds the transfer open", async () => {
      ;(BridgeWithdrawal.find as jest.Mock).mockReturnValue(
        makeWithdrawalFind([BRIDGE_WITHDRAWAL_SEND_FAILED]),
      )
      ;(BridgeApiClient.deleteTransfer as jest.Mock).mockRejectedValue(
        new Error("Bridge 500"),
      )
      ;(BridgeApiClient.getTransfer as jest.Mock).mockResolvedValue({
        id: "tr_withdrawal_002",
        state: "awaiting_funds",
      })

      const result = await reconcileBridgeAndIbexWithdrawals()

      expect(result).toEqual(
        expect.objectContaining({
          cancelledSendFailedTransfers: 0,
          bridgeTransferWithoutIbexSend: 1,
        }),
      )
      expect(BridgeAccountsRepo.markSendFailedTransferCancelled).not.toHaveBeenCalled()
      expect(upsertBridgeReconciliationOrphan).toHaveBeenCalledWith(
        expect.objectContaining({
          orphanKey: "withdrawal-send-failed:tr_withdrawal_002",
          triageContext: expect.objectContaining({ deleteTransferError: "Bridge 500" }),
        }),
      )
      expect(alertIbexReconciliationOrphan).toHaveBeenCalledTimes(1)
    })

    it("does not alert again for a withdrawal orphan already on file", async () => {
      ;(upsertBridgeReconciliationOrphan as jest.Mock).mockResolvedValue({
        id: "orphan_001",
        created: false,
      })
      ;(BridgeWithdrawal.find as jest.Mock).mockReturnValue(
        makeWithdrawalFind([BRIDGE_WITHDRAWAL_SEND_FAILED, BRIDGE_WITHDRAWAL_USDT_SENT]),
      )
      ;(BridgeApiClient.deleteTransfer as jest.Mock).mockRejectedValue(
        new Error("Bridge 500"),
      )
      ;(BridgeApiClient.getTransfer as jest.Mock)
        .mockResolvedValueOnce({ id: "tr_withdrawal_002", state: "awaiting_funds" })
        .mockResolvedValueOnce({ id: "tr_withdrawal_001", state: "error" })

      const result = await reconcileBridgeAndIbexWithdrawals()

      expect(result).toEqual(
        expect.objectContaining({
          bridgeTransferWithoutIbexSend: 1,
          ibexSendWithoutBridgeSettlement: 1,
        }),
      )
      expect(upsertBridgeReconciliationOrphan).toHaveBeenCalledTimes(2)
      expect(alertIbexReconciliationOrphan).not.toHaveBeenCalled()
    })

    it("flags, once, USDT IBEX sent that Bridge has not paid out after stuckAfterMs", async () => {
      const sentTwoDaysAgo = {
        ...BRIDGE_WITHDRAWAL_USDT_SENT,
        updatedAt: new Date(Date.now() - 48 * HOUR),
      }
      ;(BridgeWithdrawal.find as jest.Mock).mockReturnValue(
        makeWithdrawalFind([sentTwoDaysAgo]),
      )
      ;(BridgeApiClient.getTransfer as jest.Mock).mockResolvedValue({
        id: "tr_withdrawal_001",
        state: "payment_submitted",
        on_behalf_of: "cust_001",
      })

      const result = await reconcileBridgeAndIbexWithdrawals({
        windowMs: 30 * 24 * HOUR,
        stuckAfterMs: 24 * HOUR,
      })

      expect(result).toEqual(
        expect.objectContaining({
          stuckAwaitingBridge: 1,
          ibexSendWithoutBridgeSettlement: 0,
        }),
      )
      expect(upsertBridgeReconciliationOrphan).toHaveBeenCalledWith(
        expect.objectContaining({
          orphanKey: "withdrawal-ibex-sent-stuck:tr_withdrawal_001",
          orphanType: "ibex_send_without_bridge_settlement",
          triageContext: expect.objectContaining({ bridgeState: "payment_submitted" }),
        }),
      )
      expect(alertIbexReconciliationOrphan).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: expect.stringContaining("still payment_submitted after 48h"),
        }),
      )
    })

    it("leaves a withdrawal Bridge is still working on alone when it is young or no threshold is set", async () => {
      const sentAnHourAgo = {
        ...BRIDGE_WITHDRAWAL_USDT_SENT,
        updatedAt: new Date(Date.now() - HOUR),
      }
      const sentLongAgo = {
        ...BRIDGE_WITHDRAWAL_USDT_SENT,
        bridgeTransferId: "tr_old",
        updatedAt: new Date(Date.now() - 72 * HOUR),
      }
      ;(BridgeApiClient.getTransfer as jest.Mock).mockResolvedValue({
        id: "tr",
        state: "awaiting_funds",
      })
      ;(BridgeWithdrawal.find as jest.Mock).mockReturnValue(
        makeWithdrawalFind([sentAnHourAgo]),
      )
      await reconcileBridgeAndIbexWithdrawals({ stuckAfterMs: 24 * HOUR })
      ;(BridgeWithdrawal.find as jest.Mock).mockReturnValue(
        makeWithdrawalFind([sentLongAgo]),
      )
      const noThreshold = await reconcileBridgeAndIbexWithdrawals()

      expect(noThreshold).toEqual(expect.objectContaining({ stuckAwaitingBridge: 0 }))
      expect(upsertBridgeReconciliationOrphan).not.toHaveBeenCalled()
    })

    it("counts a failure for one withdrawal and goes on to the next", async () => {
      const second = { ...BRIDGE_WITHDRAWAL_USDT_SENT, bridgeTransferId: "tr_second" }
      ;(BridgeWithdrawal.find as jest.Mock).mockReturnValue(
        makeWithdrawalFind([BRIDGE_WITHDRAWAL_USDT_SENT, second]),
      )
      ;(BridgeApiClient.getTransfer as jest.Mock)
        .mockRejectedValueOnce(new Error("Bridge timeout"))
        .mockResolvedValueOnce({ id: "tr_second", state: "payment_processed" })

      const result = await reconcileBridgeAndIbexWithdrawals()

      expect(result).toEqual(
        expect.objectContaining({ failures: 1, finalizedCompletedTransfers: 1 }),
      )
      expect(BridgeAccountsRepo.updateWithdrawalStatus).toHaveBeenCalledWith(
        "tr_second",
        "completed",
      )
    })
  })
})
