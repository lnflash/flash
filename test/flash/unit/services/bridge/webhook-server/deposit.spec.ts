// AC3: Bridge fee value persisted on every deposit row

jest.mock("@services/lock", () => ({
  LockService: jest.fn(),
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock("@services/mongoose/bridge-deposit-log", () => ({
  createBridgeDeposit: jest.fn(),
}))

jest.mock("@services/bridge/reconciliation", () => ({
  reconcileByTxHash: jest.fn().mockResolvedValue({ status: "matched" }),
}))

jest.mock("@services/frappe/BridgeTransferRequestWriter", () => ({
  writeBridgeDepositRequest: jest.fn(),
}))

import { Request, Response } from "express"
import { LockService } from "@services/lock"
import * as DepositLog from "@services/mongoose/bridge-deposit-log"
import { writeBridgeDepositRequest } from "@services/frappe/BridgeTransferRequestWriter"
import { depositHandler } from "@services/bridge/webhook-server/routes/deposit"

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeRes = () => {
  const res = { status: jest.fn(), json: jest.fn() } as unknown as Response
  ;(res.status as jest.Mock).mockReturnValue(res)
  ;(res.json as jest.Mock).mockReturnValue(res)
  return res
}

const makeReq = (body: Record<string, unknown>) => ({ body }) as unknown as Request

// Real Bridge deposit event shape
const VALID_EVENT_OBJECT = {
  id: "tr_xyz789abc123",
  state: "funds_received",
  amount: "1.00",
  currency: "usd",
  developer_fee: "0.0",
  on_behalf_of: "cust_bob",
  source: {
    currency: "usdb",
    payment_rail: "bridge_wallet",
    bridge_wallet_id: "wallet_bob_usdb",
  },
  receipt: {
    developer_fee: "0.0",
    initial_amount: "1.00",
    subtotal_amount: "1.00",
    final_amount: "1.00",
    destination_tx_hash: "4gJH6oXpZUNgC1QLh8mXNPF92LtLKzHZj5eHuQrdQAgB",
  },
  created_at: "2025-06-11T21:27:00.000Z",
  updated_at: "2025-06-11T21:27:01.000Z",
}

const VALID_BODY = {
  api_version: "v0",
  event_id: "wh_789xyz654mno",
  event_category: "transfer",
  event_type: "updated.status_transitioned",
  event_object_id: "tr_xyz789abc123",
  event_object_status: "funds_received",
  event_object: VALID_EVENT_OBJECT,
  event_object_changes: { state: ["payment_submitted", "funds_received"] },
  event_created_at: "2025-06-11T21:27:00.000Z",
}

// ── Setup ─────────────────────────────────────────────────────────────────────

const mockLockService = (acquired = true) => {
  ;(LockService as jest.Mock).mockReturnValue({
    lockIdempotencyKey: jest
      .fn()
      .mockResolvedValue(acquired ? {} : new Error("already locked")),
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  mockLockService(true)
  ;(writeBridgeDepositRequest as jest.Mock).mockResolvedValue(true)
})

// ── Invalid payload ───────────────────────────────────────────────────────────

describe("depositHandler — invalid payload", () => {
  it("returns 400 when event_id is missing", async () => {
    const res = makeRes()
    const body: Record<string, unknown> = { ...VALID_BODY }
    delete body.event_id
    await depositHandler(makeReq(body), res)
    expect(res.status as jest.Mock).toHaveBeenCalledWith(400)
    expect(DepositLog.createBridgeDeposit).not.toHaveBeenCalled()
  })

  it("returns 400 when event_object.id is missing", async () => {
    const res = makeRes()
    const objWithoutId: Record<string, unknown> = { ...VALID_EVENT_OBJECT }
    delete objWithoutId.id
    await depositHandler(makeReq({ ...VALID_BODY, event_object: objWithoutId }), res)
    expect(res.status as jest.Mock).toHaveBeenCalledWith(400)
    expect(DepositLog.createBridgeDeposit).not.toHaveBeenCalled()
  })

  it("acknowledges Bridge wallet activity without amount or customer identifiers", async () => {
    const res = makeRes()
    await depositHandler(
      makeReq({
        ...VALID_BODY,
        event_category: "bridge_wallet.activity",
        event_object: {
          id: "activity_wallet_balance",
          type: "balance_changed",
          bridge_wallet_id: "wallet_123",
          available_balance: "100.00",
          currency: "usdb",
        },
      }),
      res,
    )

    expect(res.status as jest.Mock).toHaveBeenCalledWith(200)
    expect(res.json as jest.Mock).toHaveBeenCalledWith({
      status: "skipped",
      reason: "missing_crediting_fields",
    })
    expect(DepositLog.createBridgeDeposit).not.toHaveBeenCalled()
    expect(writeBridgeDepositRequest).not.toHaveBeenCalled()
  })
})

// ── Idempotency ───────────────────────────────────────────────────────────────

describe("depositHandler — idempotency", () => {
  it("returns already_processed only after idempotent local and audit writes on duplicate delivery", async () => {
    const lockFn = jest.fn().mockResolvedValueOnce(new Error("already locked"))
    ;(LockService as jest.Mock).mockReturnValue({ lockIdempotencyKey: lockFn })
    ;(DepositLog.createBridgeDeposit as jest.Mock).mockResolvedValue({ id: "log-dup" })

    const res = makeRes()
    await depositHandler(makeReq(VALID_BODY), res)

    expect(res.json as jest.Mock).toHaveBeenCalledWith({ status: "already_processed" })
    expect(DepositLog.createBridgeDeposit).toHaveBeenCalledTimes(1)
    expect(writeBridgeDepositRequest).toHaveBeenCalledTimes(1)
    expect(lockFn).toHaveBeenCalledTimes(1)
  })

  it("locks on the event id after writing the audit row", async () => {
    ;(DepositLog.createBridgeDeposit as jest.Mock).mockResolvedValue({ id: "log-1" })

    const lockFn = jest.fn().mockResolvedValue({})
    ;(LockService as jest.Mock).mockReturnValue({ lockIdempotencyKey: lockFn })

    await depositHandler(makeReq(VALID_BODY), makeRes())
    expect(lockFn).toHaveBeenCalledWith("bridge-deposit:wh_789xyz654mno")
  })
})

// ── AC3: Fee persistence ──────────────────────────────────────────────────────

describe("depositHandler — fee persistence (AC3)", () => {
  it("persists developer_fee from the receipt on every deposit event", async () => {
    ;(DepositLog.createBridgeDeposit as jest.Mock).mockResolvedValue({
      id: "log-fee-001",
    })

    const res = makeRes()
    await depositHandler(makeReq(VALID_BODY), res)

    expect(DepositLog.createBridgeDeposit).toHaveBeenCalledTimes(1)
    expect(DepositLog.createBridgeDeposit).toHaveBeenCalledWith(
      expect.objectContaining({
        developerFee: "0.0",
      }),
    )
  })

  it("persists the full deposit record with transfer id, customer, state and receipt breakdown", async () => {
    ;(DepositLog.createBridgeDeposit as jest.Mock).mockResolvedValue({
      id: "log-fee-002",
    })

    const res = makeRes()
    await depositHandler(makeReq(VALID_BODY), res)

    expect(DepositLog.createBridgeDeposit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "wh_789xyz654mno",
        transferId: "tr_xyz789abc123",
        customerId: "cust_bob",
        state: "funds_received",
        amount: "1.00",
        currency: "usd",
        subtotalAmount: "1.00",
        initialAmount: "1.00",
        finalAmount: "1.00",
        destinationTxHash: "4gJH6oXpZUNgC1QLh8mXNPF92LtLKzHZj5eHuQrdQAgB",
      }),
    )
  })

  it("does not use destination payment rail as a currency fallback", async () => {
    ;(DepositLog.createBridgeDeposit as jest.Mock).mockResolvedValue({
      id: "log-currency-001",
    })

    const eventObject = {
      ...VALID_EVENT_OBJECT,
      currency: undefined,
      destination_payment_rail: "ach",
    }

    await depositHandler(makeReq({ ...VALID_BODY, event_object: eventObject }), makeRes())

    expect(DepositLog.createBridgeDeposit).toHaveBeenCalledWith(
      expect.objectContaining({
        currency: "usd",
      }),
    )
  })

  it("returns 200 success after persisting the deposit log", async () => {
    ;(DepositLog.createBridgeDeposit as jest.Mock).mockResolvedValue({
      id: "log-fee-003",
    })

    const res = makeRes()
    await depositHandler(makeReq(VALID_BODY), res)

    expect(res.status as jest.Mock).toHaveBeenCalledWith(200)
    expect(res.json as jest.Mock).toHaveBeenCalledWith({ status: "success" })
  })

  it("returns 500 when log persistence fails", async () => {
    ;(DepositLog.createBridgeDeposit as jest.Mock).mockResolvedValue(
      new Error("mongo timeout"),
    )

    const res = makeRes()
    await depositHandler(makeReq(VALID_BODY), res)

    expect(res.status as jest.Mock).toHaveBeenCalledWith(500)
  })

  it("handles null developer_fee gracefully", async () => {
    ;(DepositLog.createBridgeDeposit as jest.Mock).mockResolvedValue({
      id: "log-fee-004",
    })

    const body = {
      ...VALID_BODY,
      event_object: {
        ...VALID_EVENT_OBJECT,
        receipt: { ...VALID_EVENT_OBJECT.receipt, developer_fee: null },
      },
    }

    const res = makeRes()
    await depositHandler(makeReq(body), res)

    expect(DepositLog.createBridgeDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ developerFee: "0.0" }),
    )
    expect(res.status as jest.Mock).toHaveBeenCalledWith(200)
  })

  it("writes an ERPNext audit row after the deposit log is persisted", async () => {
    ;(DepositLog.createBridgeDeposit as jest.Mock).mockResolvedValue({
      id: "log-audit-001",
    })

    const res = makeRes()
    await depositHandler(makeReq(VALID_BODY), res)

    expect(writeBridgeDepositRequest).toHaveBeenCalledWith({
      eventId: "wh_789xyz654mno",
      eventObject: VALID_EVENT_OBJECT,
      rawPayload: VALID_BODY,
    })
    expect(res.status as jest.Mock).toHaveBeenCalledWith(200)
  })

  it("returns 500 when the ERPNext audit write fails", async () => {
    ;(DepositLog.createBridgeDeposit as jest.Mock).mockResolvedValue({
      id: "log-audit-002",
    })
    ;(writeBridgeDepositRequest as jest.Mock).mockResolvedValue(
      new Error("erpnext timeout"),
    )
    const lockFn = jest.fn().mockResolvedValue({})
    ;(LockService as jest.Mock).mockReturnValue({ lockIdempotencyKey: lockFn })

    const res = makeRes()
    await depositHandler(makeReq(VALID_BODY), res)

    expect(res.status as jest.Mock).toHaveBeenCalledWith(500)
    expect(res.json as jest.Mock).toHaveBeenCalledWith({
      error: "Failed to persist ERPNext audit row",
    })
    expect(lockFn).not.toHaveBeenCalled()
  })
})
