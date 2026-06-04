jest.mock("@services/lock", () => ({
  LockService: jest.fn(),
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock("@services/mongoose/bridge-accounts", () => ({
  BRIDGE_WITHDRAWAL_NOT_FOUND: "Withdrawal not found",
  updateWithdrawalStatus: jest.fn(),
}))

jest.mock("@app/bridge/send-withdrawal-notification", () => ({
  sendBridgeWithdrawalNotificationBestEffort: jest.fn().mockResolvedValue(undefined),
}))

jest.mock("@services/frappe/BridgeTransferRequestWriter", () => ({
  writeBridgeCashoutCompleted: jest.fn(),
  writeBridgeCashoutFailed: jest.fn(),
}))

import { Request, Response } from "express"
import { LockService } from "@services/lock"
import * as BridgeAccountsRepo from "@services/mongoose/bridge-accounts"
import { sendBridgeWithdrawalNotificationBestEffort } from "@app/bridge/send-withdrawal-notification"
import {
  writeBridgeCashoutCompleted,
  writeBridgeCashoutFailed,
} from "@services/frappe/BridgeTransferRequestWriter"
import { transferHandler } from "@services/bridge/webhook-server/routes/transfer"

const makeRes = () => {
  const res = { status: jest.fn(), json: jest.fn() } as unknown as Response
  ;(res.status as jest.Mock).mockReturnValue(res)
  ;(res.json as jest.Mock).mockReturnValue(res)
  return res
}

const makeReq = (body: Record<string, unknown>) => ({ body }) as unknown as Request

const WITHDRAWAL_RECORD = { id: "wd-1", status: "pending", bridgeTransferId: "tr-abc" }

const updateFn = BridgeAccountsRepo.updateWithdrawalStatus as jest.Mock
let lockFn: jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  lockFn = jest.fn().mockResolvedValue({})
  updateFn.mockResolvedValue({ ...WITHDRAWAL_RECORD, status: "completed" })
  ;(LockService as jest.Mock).mockReturnValue({ lockIdempotencyKey: lockFn })
  ;(writeBridgeCashoutCompleted as jest.Mock).mockResolvedValue(true)
  ;(writeBridgeCashoutFailed as jest.Mock).mockResolvedValue(true)
})

describe("transferHandler", () => {
  it("returns 503 when withdrawal row is not found yet (retryable)", async () => {
    const { RepositoryError } = jest.requireActual("@domain/errors")
    updateFn.mockResolvedValue(new RepositoryError("Withdrawal not found"))

    const res = makeRes()
    await transferHandler(
      makeReq({
        event: "transfer.failed",
        data: { transfer_id: "tr-early", state: "canceled", reason: "rejected" },
      }),
      res,
    )

    expect(res.status as jest.Mock).toHaveBeenCalledWith(503)
    expect(lockFn).not.toHaveBeenCalled()
  })

  it("acquires idempotency lock only after a successful status and audit update", async () => {
    const res = makeRes()
    await transferHandler(
      makeReq({
        event: "transfer.completed",
        event_id: "wh-transfer-1",
        data: {
          transfer_id: "tr-abc",
          state: "payment_processed",
          amount: "25.00",
          currency: "usdt",
        },
      }),
      res,
    )

    expect(updateFn).toHaveBeenCalled()
    expect(writeBridgeCashoutCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        transferId: "tr-abc",
        amount: "25.00",
        currency: "usdt",
        sourceEventId: "wh-transfer-1",
        sourceEventType: "transfer.completed",
      }),
    )
    expect(lockFn).toHaveBeenCalledWith(
      "bridge-transfer:tr-abc:transfer.completed:payment_processed",
    )
    expect(res.status as jest.Mock).toHaveBeenCalledWith(200)
  })

  it("does not acquire lock when status update fails", async () => {
    const { RepositoryError } = jest.requireActual("@domain/errors")
    updateFn.mockResolvedValue(new RepositoryError("mongo error"))

    const res = makeRes()
    await transferHandler(
      makeReq({
        event: "transfer.failed",
        data: { transfer_id: "tr-abc", state: "canceled" },
      }),
      res,
    )

    expect(res.status as jest.Mock).toHaveBeenCalledWith(500)
    expect(lockFn).not.toHaveBeenCalled()
  })

  it("ignores refund_in_flight without updating withdrawal status", async () => {
    const res = makeRes()
    await transferHandler(
      makeReq({
        event: "transfer.failed",
        data: { transfer_id: "tr-abc", state: "refund_in_flight" },
      }),
      res,
    )

    expect(updateFn).not.toHaveBeenCalled()
    expect(lockFn).not.toHaveBeenCalled()
    expect(res.status as jest.Mock).toHaveBeenCalledWith(200)
    expect((res.json as jest.Mock).mock.calls[0][0]).toEqual({
      status: "ignored_transient_state",
    })
  })

  it("returns already_processed when lock is held after a prior successful run", async () => {
    lockFn.mockResolvedValue(new Error("already locked"))

    const res = makeRes()
    await transferHandler(
      makeReq({
        event: "transfer.completed",
        data: { transfer_id: "tr-abc", state: "payment_processed" },
      }),
      res,
    )

    expect(res.status as jest.Mock).toHaveBeenCalledWith(200)
    expect((res.json as jest.Mock).mock.calls[0][0]).toEqual({ status: "already_processed" })
  })

  it("sends a push notification after a successful completion", async () => {
    updateFn.mockResolvedValue({
      ...WITHDRAWAL_RECORD,
      status: "completed",
      accountId: "acct-1",
      amount: "25.00",
      currency: "usdt",
    })

    const res = makeRes()
    await transferHandler(
      makeReq({
        event: "transfer.completed",
        data: { transfer_id: "tr-abc", state: "payment_processed" },
      }),
      res,
    )

    expect(sendBridgeWithdrawalNotificationBestEffort).toHaveBeenCalledWith({
      accountId: "acct-1",
      amount: "25.00",
      currency: "usdt",
      outcome: "completed",
    })
  })

  it("does not send a push notification when the idempotency lock is already held", async () => {
    lockFn.mockResolvedValue(new Error("already locked"))

    const res = makeRes()
    await transferHandler(
      makeReq({
        event: "transfer.completed",
        data: { transfer_id: "tr-abc", state: "payment_processed" },
      }),
      res,
    )

    expect(sendBridgeWithdrawalNotificationBestEffort).not.toHaveBeenCalled()
  })

  it("returns 500 and does not mark processed when the completed audit write fails", async () => {
    ;(writeBridgeCashoutCompleted as jest.Mock).mockResolvedValue(
      new Error("erpnext timeout"),
    )

    const res = makeRes()
    await transferHandler(
      makeReq({
        event: "transfer.completed",
        data: {
          transfer_id: "tr-abc",
          state: "payment_processed",
          amount: "25.00",
          currency: "usdt",
        },
      }),
      res,
    )

    expect(res.status as jest.Mock).toHaveBeenCalledWith(500)
    expect(res.json as jest.Mock).toHaveBeenCalledWith({
      error: "Failed to persist ERPNext audit row",
    })
    expect(lockFn).not.toHaveBeenCalled()
    expect(sendBridgeWithdrawalNotificationBestEffort).not.toHaveBeenCalled()
  })

  it("writes a failed cashout audit row before marking a failed transfer processed", async () => {
    updateFn.mockResolvedValue({
      ...WITHDRAWAL_RECORD,
      status: "failed",
      accountId: "acct-1",
      amount: "25.00",
      currency: "usdt",
      failureReason: "ACH return",
    })

    const res = makeRes()
    await transferHandler(
      makeReq({
        event: "transfer.failed",
        event_id: "wh-transfer-2",
        data: {
          transfer_id: "tr-abc",
          state: "returned",
          reason: "ACH return",
          amount: "25.00",
          currency: "usdt",
        },
      }),
      res,
    )

    expect(writeBridgeCashoutFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        transferId: "tr-abc",
        amount: "25.00",
        currency: "usdt",
        accountId: "acct-1",
        failureReason: "ACH return",
        sourceEventId: "wh-transfer-2",
      }),
    )
    expect(lockFn).toHaveBeenCalled()
    expect(res.status as jest.Mock).toHaveBeenCalledWith(200)
  })

  it("returns 200 already_terminal when failure arrives after completion", async () => {
    const { RepositoryError } = jest.requireActual("@domain/errors")
    updateFn.mockResolvedValue(
      new RepositoryError("Withdrawal already completed, cannot transition to failed"),
    )

    const res = makeRes()
    await transferHandler(
      makeReq({
        event: "transfer.failed",
        data: { transfer_id: "tr-abc", state: "returned", reason: "ACH return" },
      }),
      res,
    )

    expect(res.status as jest.Mock).toHaveBeenCalledWith(200)
    expect((res.json as jest.Mock).mock.calls[0][0]).toEqual({ status: "already_terminal" })
    expect(lockFn).not.toHaveBeenCalled()
  })
})
