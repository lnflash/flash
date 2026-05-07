// AC3: Bridge fee value persisted on every deposit row

jest.mock("@services/lock", () => ({
  LockService: jest.fn(),
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock("@services/mongoose/bridge-deposit-log", () => ({
  createBridgeDepositLog: jest.fn(),
}))

import { Request, Response } from "express"
import { LockService } from "@services/lock"
import * as DepositLog from "@services/mongoose/bridge-deposit-log"
import { depositHandler } from "@services/bridge/webhook-server/routes/deposit"

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeRes = () => {
  const res = { status: jest.fn(), json: jest.fn() } as unknown as Response
  ;(res.status as jest.Mock).mockReturnValue(res)
  ;(res.json as jest.Mock).mockReturnValue(res)
  return res
}

const makeReq = (body: Record<string, unknown>) =>
  ({ body } as unknown as Request)

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
})

// ── Invalid payload ───────────────────────────────────────────────────────────

describe("depositHandler — invalid payload", () => {
  it("returns 400 when event_id is missing", async () => {
    const res = makeRes()
    const { event_id: _, ...body } = VALID_BODY
    await depositHandler(makeReq(body), res)
    expect(res.status as jest.Mock).toHaveBeenCalledWith(400)
    expect(DepositLog.createBridgeDepositLog).not.toHaveBeenCalled()
  })

  it("returns 400 when event_object.id is missing", async () => {
    const res = makeRes()
    const { id: _, ...objWithoutId } = VALID_EVENT_OBJECT
    await depositHandler(makeReq({ ...VALID_BODY, event_object: objWithoutId }), res)
    expect(res.status as jest.Mock).toHaveBeenCalledWith(400)
    expect(DepositLog.createBridgeDepositLog).not.toHaveBeenCalled()
  })
})

// ── Idempotency ───────────────────────────────────────────────────────────────

describe("depositHandler — idempotency", () => {
  it("returns already_processed without persisting on duplicate state transition", async () => {
    mockLockService(false)

    const res = makeRes()
    await depositHandler(makeReq(VALID_BODY), res)

    expect(res.json as jest.Mock).toHaveBeenCalledWith({ status: "already_processed" })
    expect(DepositLog.createBridgeDepositLog).not.toHaveBeenCalled()
  })

  it("locks on transfer id + state so different states for same transfer are processed", async () => {
    ;(DepositLog.createBridgeDepositLog as jest.Mock).mockResolvedValue({ id: "log-1" })

    const lockFn = jest.fn().mockResolvedValue({})
    ;(LockService as jest.Mock).mockReturnValue({ lockIdempotencyKey: lockFn })

    await depositHandler(makeReq(VALID_BODY), makeRes())
    expect(lockFn).toHaveBeenCalledWith("bridge-deposit:tr_xyz789abc123:funds_received")

    await depositHandler(
      makeReq({
        ...VALID_BODY,
        event_object: { ...VALID_EVENT_OBJECT, state: "payment_processed" },
      }),
      makeRes(),
    )
    expect(lockFn).toHaveBeenCalledWith(
      "bridge-deposit:tr_xyz789abc123:payment_processed",
    )
  })
})

// ── AC3: Fee persistence ──────────────────────────────────────────────────────

describe("depositHandler — fee persistence (AC3)", () => {
  it("persists developer_fee from the receipt on every deposit event", async () => {
    ;(DepositLog.createBridgeDepositLog as jest.Mock).mockResolvedValue({
      id: "log-fee-001",
    })

    const res = makeRes()
    await depositHandler(makeReq(VALID_BODY), res)

    expect(DepositLog.createBridgeDepositLog).toHaveBeenCalledTimes(1)
    expect(DepositLog.createBridgeDepositLog).toHaveBeenCalledWith(
      expect.objectContaining({
        developerFee: "0.0",
      }),
    )
  })

  it("persists the full deposit record with transfer id, customer, state and receipt breakdown", async () => {
    ;(DepositLog.createBridgeDepositLog as jest.Mock).mockResolvedValue({
      id: "log-fee-002",
    })

    const res = makeRes()
    await depositHandler(makeReq(VALID_BODY), res)

    expect(DepositLog.createBridgeDepositLog).toHaveBeenCalledWith(
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

  it("returns 200 success after persisting the deposit log", async () => {
    ;(DepositLog.createBridgeDepositLog as jest.Mock).mockResolvedValue({
      id: "log-fee-003",
    })

    const res = makeRes()
    await depositHandler(makeReq(VALID_BODY), res)

    expect(res.status as jest.Mock).toHaveBeenCalledWith(200)
    expect(res.json as jest.Mock).toHaveBeenCalledWith({ status: "success" })
  })

  it("returns 500 when log persistence fails", async () => {
    ;(DepositLog.createBridgeDepositLog as jest.Mock).mockResolvedValue(
      new Error("mongo timeout"),
    )

    const res = makeRes()
    await depositHandler(makeReq(VALID_BODY), res)

    expect(res.status as jest.Mock).toHaveBeenCalledWith(500)
  })

  it("handles null developer_fee gracefully", async () => {
    ;(DepositLog.createBridgeDepositLog as jest.Mock).mockResolvedValue({
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

    expect(DepositLog.createBridgeDepositLog).toHaveBeenCalledWith(
      expect.objectContaining({ developerFee: "0.0" }),
    )
    expect(res.status as jest.Mock).toHaveBeenCalledWith(200)
  })
})
