const mockCreateBridgeDeposit = jest.fn()
const mockWriteDepositRequest = jest.fn()
const mockLockIdempotencyKey = jest.fn()
const mockUpdateWithdrawalStatus = jest.fn()
const mockWriteCashoutCompleted = jest.fn()
const mockWriteCashoutFailed = jest.fn()

jest.mock("@services/alerts/ops-events", () => ({
  notifyOpsEvent: jest.fn().mockResolvedValue(undefined),
}))

jest.mock("@services/alerts", () => ({
  alertBridge: jest.fn(),
  generateDedupKey: new Proxy({}, { get: () => jest.fn(() => "dedup") }),
}))

jest.mock("@services/alerts/ibex-bridge-movement", () => ({
  alertIbexReconciliationFailed: jest.fn(),
}))

jest.mock("@services/lock", () => ({
  LockService: jest.fn(() => ({
    lockIdempotencyKey: (...args: unknown[]) => mockLockIdempotencyKey(...args),
  })),
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock("@services/mongoose/bridge-deposit-log", () => ({
  createBridgeDeposit: (...args: unknown[]) => mockCreateBridgeDeposit(...args),
}))

jest.mock("@services/bridge/reconciliation", () => ({
  reconcileByTxHash: jest.fn().mockResolvedValue({ status: "matched" }),
}))

jest.mock("@services/frappe/BridgeTransferRequestWriter", () => ({
  writeBridgeDepositRequest: (...args: unknown[]) => mockWriteDepositRequest(...args),
  writeBridgeCashoutCompleted: (...args: unknown[]) => mockWriteCashoutCompleted(...args),
  writeBridgeCashoutFailed: (...args: unknown[]) => mockWriteCashoutFailed(...args),
}))

jest.mock("@services/mongoose/bridge-accounts", () => ({
  BRIDGE_WITHDRAWAL_NOT_FOUND: "Bridge withdrawal not found",
  updateWithdrawalStatus: (...args: unknown[]) => mockUpdateWithdrawalStatus(...args),
}))

jest.mock("@app/bridge/send-withdrawal-notification", () => ({
  sendBridgeWithdrawalNotificationBestEffort: jest.fn().mockResolvedValue(undefined),
}))

import { Request, Response } from "express"
import { depositHandler } from "@services/bridge/webhook-server/routes/deposit"
import { transferHandler } from "@services/bridge/webhook-server/routes/transfer"
import { notifyOpsEvent } from "@services/alerts/ops-events"

const makeRes = () => {
  const res = { status: jest.fn(), json: jest.fn() } as unknown as Response
  ;(res.status as jest.Mock).mockReturnValue(res)
  ;(res.json as jest.Mock).mockReturnValue(res)
  return res
}

const makeReq = (body: Record<string, unknown>) => ({ body }) as unknown as Request

describe("ops events — bridge webhook hooks", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockLockIdempotencyKey.mockResolvedValue(true)
  })

  describe("depositHandler", () => {
    const depositBody = {
      event_id: "wh_123",
      event_category: "transfer",
      event_object: {
        id: "tr_xyz789abc123",
        state: "payment_processed",
        amount: "25.00",
        currency: "usd",
        on_behalf_of: "cust_bob_1234567890",
      },
    }

    it("notifies deposit succeeded when processing completes", async () => {
      mockCreateBridgeDeposit.mockResolvedValue({})
      mockWriteDepositRequest.mockResolvedValue({})
      const res = makeRes()

      await depositHandler(makeReq(depositBody), res)

      expect(res.status).toHaveBeenCalledWith(200)
      expect(notifyOpsEvent).toHaveBeenCalledTimes(1)
      expect(notifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          flow: "deposit",
          phase: "succeeded",
          status: "success",
          amount: { value: "25.00", currency: "usd" },
          meta: expect.objectContaining({ transferId: "tr_xyz789abc123" }),
        }),
      )
    })

    it("notifies deposit failed when persistence fails", async () => {
      mockCreateBridgeDeposit.mockResolvedValue(new Error("mongo down"))
      const res = makeRes()

      await depositHandler(makeReq(depositBody), res)

      expect(res.status).toHaveBeenCalledWith(500)
      expect(notifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          flow: "deposit",
          phase: "failed",
          status: "failed",
          step: "persist-deposit-log",
          error: "Error",
        }),
      )
    })

    it("notifies deposit failed when the ERPNext audit write fails", async () => {
      mockCreateBridgeDeposit.mockResolvedValue({})
      mockWriteDepositRequest.mockResolvedValue(new Error("erpnext down"))
      const res = makeRes()

      await depositHandler(makeReq(depositBody), res)

      expect(res.status).toHaveBeenCalledWith(500)
      expect(notifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          flow: "deposit",
          phase: "failed",
          status: "failed",
          step: "erpnext-audit",
        }),
      )
    })

    it("does not notify for duplicate deliveries", async () => {
      mockCreateBridgeDeposit.mockResolvedValue({})
      mockWriteDepositRequest.mockResolvedValue({})
      mockLockIdempotencyKey.mockResolvedValue(new Error("already locked"))
      const res = makeRes()

      await depositHandler(makeReq(depositBody), res)

      expect(res.status).toHaveBeenCalledWith(200)
      expect(res.json).toHaveBeenCalledWith({ status: "already_processed" })
      expect(notifyOpsEvent).not.toHaveBeenCalled()
    })
  })

  describe("transferHandler", () => {
    const transferBody = (
      state: string,
      event = "transfer.updated.status_transitioned",
    ) => ({
      event_id: "wh_456",
      event_type: event,
      event_object: { id: "tr_transfer_123", state, amount: "10.00", currency: "usd" },
    })

    it("notifies transfer succeeded on completion", async () => {
      mockUpdateWithdrawalStatus.mockResolvedValue({
        accountId: "64df1a2b3c4d5e6f78901234",
        amount: "10.00",
        currency: "usd",
      })
      mockWriteCashoutCompleted.mockResolvedValue({})
      const res = makeRes()

      await transferHandler(makeReq(transferBody("payment_processed")), res)

      expect(res.status).toHaveBeenCalledWith(200)
      expect(notifyOpsEvent).toHaveBeenCalledTimes(1)
      expect(notifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          flow: "transfer",
          phase: "succeeded",
          status: "success",
          accountId: "64df1a2b3c4d5e6f78901234",
          amount: { value: "10.00", currency: "usd" },
          meta: { transferId: "tr_transfer_123" },
        }),
      )
    })

    it("notifies transfer failed on a terminal failure state", async () => {
      mockUpdateWithdrawalStatus.mockResolvedValue({
        accountId: "64df1a2b3c4d5e6f78901234",
        amount: "10.00",
        currency: "usd",
        failureReason: "account_closed",
      })
      mockWriteCashoutFailed.mockResolvedValue({})
      const res = makeRes()

      await transferHandler(makeReq(transferBody("returned")), res)

      expect(res.status).toHaveBeenCalledWith(200)
      expect(notifyOpsEvent).toHaveBeenCalledTimes(1)
      expect(notifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          flow: "transfer",
          phase: "failed",
          status: "failed",
          accountId: "64df1a2b3c4d5e6f78901234",
          error: "account_closed",
        }),
      )
    })

    it("does not notify for ignored transient states", async () => {
      const res = makeRes()

      await transferHandler(makeReq(transferBody("refund_in_flight")), res)

      expect(notifyOpsEvent).not.toHaveBeenCalled()
    })

    it("does not notify duplicate deliveries", async () => {
      mockUpdateWithdrawalStatus.mockResolvedValue({
        accountId: "64df1a2b3c4d5e6f78901234",
        amount: "10.00",
        currency: "usd",
      })
      mockWriteCashoutCompleted.mockResolvedValue({})
      mockLockIdempotencyKey.mockResolvedValue(new Error("already locked"))
      const res = makeRes()

      await transferHandler(makeReq(transferBody("payment_processed")), res)

      expect(res.json).toHaveBeenCalledWith({ status: "already_processed" })
      expect(notifyOpsEvent).not.toHaveBeenCalled()
    })
  })
})
