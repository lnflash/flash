/**
 * Unit tests for Bridge↔IBEX reconciliation
 * Covers reconcileByTxHash (real-time) and reconcileBridgeAndIbexDeposits (batch)
 */

// ── Mocks (must be before imports) ───────────────────────────────────────────

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock("@services/mongoose/schema", () => ({
  BridgeDepositLog: { findOne: jest.fn(), find: jest.fn() },
  IbexCryptoReceiveLog: { findOne: jest.fn() },
}))

jest.mock("@services/mongoose/ibex-crypto-receive-log", () => ({
  findIbexCryptoReceiveLogsSince: jest.fn(),
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

import { BridgeDepositLog, IbexCryptoReceiveLog } from "@services/mongoose/schema"
import { findIbexCryptoReceiveLogsSince } from "@services/mongoose/ibex-crypto-receive-log"
import {
  upsertBridgeReconciliationOrphan,
  resolveOrphansByTxHash,
} from "@services/mongoose/bridge-reconciliation-orphan"
import { PubSubService } from "@services/pubsub"
import {
  reconcileByTxHash,
  reconcileBridgeAndIbexDeposits,
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

// ── Helpers ───────────────────────────────────────────────────────────────────

const mockPublish = jest.fn()

const makeLeanQuery = (result: unknown) => ({
  lean: () => ({ exec: () => Promise.resolve(result) }),
})

beforeEach(() => {
  jest.clearAllMocks()
  ;(PubSubService as jest.Mock).mockReturnValue({ publish: mockPublish })
  ;(resolveOrphansByTxHash as jest.Mock).mockResolvedValue({ resolvedCount: 0 })
  ;(upsertBridgeReconciliationOrphan as jest.Mock).mockResolvedValue({ id: "orphan_001" })
})

// ── reconcileByTxHash ─────────────────────────────────────────────────────────

describe("reconcileByTxHash", () => {
  describe("both sides found → matched", () => {
    beforeEach(() => {
      ;(BridgeDepositLog.findOne as jest.Mock).mockReturnValue(makeLeanQuery(BRIDGE_DEPOSIT))
      ;(IbexCryptoReceiveLog.findOne as jest.Mock).mockReturnValue(makeLeanQuery(IBEX_RECEIVE))
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
      const [bridgeCall] = (BridgeDepositLog.findOne as jest.Mock).mock.calls
      expect(bridgeCall[0].destinationTxHash.$regex.flags).toContain("i")
    })
  })

  describe("only Bridge found → bridge_without_ibex", () => {
    beforeEach(() => {
      ;(BridgeDepositLog.findOne as jest.Mock).mockReturnValue(makeLeanQuery(BRIDGE_DEPOSIT))
      ;(IbexCryptoReceiveLog.findOne as jest.Mock).mockReturnValue(makeLeanQuery(null))
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
  })

  describe("only IBEX found → ibex_without_bridge", () => {
    beforeEach(() => {
      ;(BridgeDepositLog.findOne as jest.Mock).mockReturnValue(makeLeanQuery(null))
      ;(IbexCryptoReceiveLog.findOne as jest.Mock).mockReturnValue(makeLeanQuery(IBEX_RECEIVE))
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
  })

  describe("self-healing: second call with both sides resolves orphan", () => {
    it("resolves orphan when called again after missing side arrives", async () => {
      // First call: only Bridge
      ;(BridgeDepositLog.findOne as jest.Mock).mockReturnValue(makeLeanQuery(BRIDGE_DEPOSIT))
      ;(IbexCryptoReceiveLog.findOne as jest.Mock).mockReturnValue(makeLeanQuery(null))
      await reconcileByTxHash({ txHash: TX_HASH })
      expect(upsertBridgeReconciliationOrphan).toHaveBeenCalledTimes(1)

      jest.clearAllMocks()
      ;(PubSubService as jest.Mock).mockReturnValue({ publish: mockPublish })
      ;(resolveOrphansByTxHash as jest.Mock).mockResolvedValue({ resolvedCount: 1 })

      // Second call: both sides present (IBEX webhook arrived)
      ;(BridgeDepositLog.findOne as jest.Mock).mockReturnValue(makeLeanQuery(BRIDGE_DEPOSIT))
      ;(IbexCryptoReceiveLog.findOne as jest.Mock).mockReturnValue(makeLeanQuery(IBEX_RECEIVE))
      const result = await reconcileByTxHash({ txHash: TX_HASH })

      expect(result).not.toBeInstanceOf(Error)
      if (result instanceof Error) return
      expect(result.status).toBe("matched")
      expect(resolveOrphansByTxHash).toHaveBeenCalledWith(NORM_HASH)
      expect(upsertBridgeReconciliationOrphan).not.toHaveBeenCalled()
    })
  })

  describe("Bridge query uses payment_processed state filter", () => {
    it("passes state: payment_processed to BridgeDepositLog.findOne", async () => {
      ;(BridgeDepositLog.findOne as jest.Mock).mockReturnValue(makeLeanQuery(null))
      ;(IbexCryptoReceiveLog.findOne as jest.Mock).mockReturnValue(makeLeanQuery(null))
      await reconcileByTxHash({ txHash: TX_HASH })
      expect(BridgeDepositLog.findOne).toHaveBeenCalledWith(
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
      ;(BridgeDepositLog.find as jest.Mock).mockReturnValue(makeBridgeFind([BRIDGE_DEPOSIT]))
      ;(findIbexCryptoReceiveLogsSince as jest.Mock).mockResolvedValue([IBEX_RECEIVE])

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
      ;(BridgeDepositLog.find as jest.Mock).mockReturnValue(makeBridgeFind([BRIDGE_DEPOSIT]))
      ;(findIbexCryptoReceiveLogsSince as jest.Mock).mockResolvedValue([])

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
      ;(BridgeDepositLog.find as jest.Mock).mockReturnValue(makeBridgeFind([depositNoHash]))
      ;(findIbexCryptoReceiveLogsSince as jest.Mock).mockResolvedValue([])

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
      ;(BridgeDepositLog.find as jest.Mock).mockReturnValue(makeBridgeFind([]))
      ;(findIbexCryptoReceiveLogsSince as jest.Mock).mockResolvedValue([IBEX_RECEIVE])

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
    it("passes state: payment_processed to BridgeDepositLog.find", async () => {
      ;(BridgeDepositLog.find as jest.Mock).mockReturnValue(makeBridgeFind([]))
      ;(findIbexCryptoReceiveLogsSince as jest.Mock).mockResolvedValue([])

      await reconcileBridgeAndIbexDeposits()
      expect(BridgeDepositLog.find).toHaveBeenCalledWith(
        expect.objectContaining({ state: "payment_processed" }),
      )
    })
  })

  describe("mixed scenario", () => {
    it("counts matched and unmatched independently", async () => {
      const deposit2 = { ...BRIDGE_DEPOSIT, transferId: "tr_002", destinationTxHash: "0xother" }
      const ibex2 = { ...IBEX_RECEIVE, txHash: "0xorphan_ibex" }

      ;(BridgeDepositLog.find as jest.Mock).mockReturnValue(
        makeBridgeFind([BRIDGE_DEPOSIT, deposit2]),
      )
      ;(findIbexCryptoReceiveLogsSince as jest.Mock).mockResolvedValue([IBEX_RECEIVE, ibex2])

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
    it("returns an Error when findIbexCryptoReceiveLogsSince fails", async () => {
      ;(BridgeDepositLog.find as jest.Mock).mockReturnValue(makeBridgeFind([]))
      ;(findIbexCryptoReceiveLogsSince as jest.Mock).mockResolvedValue(
        new Error("mongo connection lost"),
      )

      const result = await reconcileBridgeAndIbexDeposits()
      expect(result).toBeInstanceOf(Error)
    })
  })
})
