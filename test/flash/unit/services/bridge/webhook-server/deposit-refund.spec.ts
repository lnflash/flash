// ENG-889: a deposit Bridge refunds (or cannot deliver) must reach ops, not
// show up in the feed as another green "deposit succeeded".

const mockCreateBridgeDeposit = jest.fn()
const mockWriteDepositRequest = jest.fn()
const mockLockIdempotencyKey = jest.fn()

jest.mock("@app/bridge/match-ibex-deposits", () => ({
  matchBridgeDepositNow: jest.fn().mockResolvedValue("no_ibex_credit"),
}))

jest.mock("@services/alerts/ops-events", () => ({
  notifyOpsEvent: jest.fn(),
}))

jest.mock("@services/alerts", () => ({
  alertBridge: jest.fn(),
  generateDedupKey: jest.requireActual("@services/alerts/dedup-key").generateDedupKey,
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
}))

import { Request, Response } from "express"
import { alertBridge } from "@services/alerts"
import { notifyOpsEvent } from "@services/alerts/ops-events"
import { depositHandler } from "@services/bridge/webhook-server/routes/deposit"

const makeRes = () => {
  const res = { status: jest.fn(), json: jest.fn() } as unknown as Response
  ;(res.status as jest.Mock).mockReturnValue(res)
  ;(res.json as jest.Mock).mockReturnValue(res)
  return res
}

const makeReq = (body: Record<string, unknown>) => ({ body }) as unknown as Request

// Shape of the 2026-11-13 production refund (identifiers replaced).
const refundedObject = {
  id: "va_event_refunded",
  type: "refunded",
  amount: "5000.0",
  currency: "usd",
  customer_id: "cust_wire",
  deposit_id: "deposit_wire_5000",
  virtual_account_id: "va_wire",
  source: {
    payment_rail: "wire",
    originator_name: "ACME HOLDINGS LLC",
    bank_name: "SENDER BANK",
    bank_routing_number: "000000000",
    imad: "20261113XXXX",
  },
  refund: {
    code: "R03",
    amount: "5000.0",
    reason: "Risk Rejection",
    refunded_at: "2026-11-14T15:00:00.000Z",
    refund_reference_id: "rref_123",
    risk_rejection_reason: "Third Party Payment",
  },
}

const bodyFor = (eventObject: Record<string, unknown>, eventId = "wh_refund") => ({
  event_id: eventId,
  event_category: "virtual_account.activity",
  event_object: eventObject,
})

beforeEach(() => {
  jest.clearAllMocks()
  mockCreateBridgeDeposit.mockResolvedValue({ id: "log_1" })
  mockWriteDepositRequest.mockResolvedValue(true)
  mockLockIdempotencyKey.mockResolvedValue({})
})

describe("depositHandler: refunds (ENG-889)", () => {
  it("alerts ops with amount, customer, deposit, refund code/reason and originator", async () => {
    const res = makeRes()
    await depositHandler(makeReq(bodyFor(refundedObject)), res)

    expect(res.status as jest.Mock).toHaveBeenCalledWith(200)
    expect(alertBridge).toHaveBeenCalledTimes(1)
    expect(alertBridge).toHaveBeenCalledWith({
      dedupKey: "bridge-webhook:deposit-not-delivered:deposit_wire_5000:refunded",
      source: "bridge-webhook",
      severity: "warning",
      title: "Bridge deposit refunded: 5000.0 USD",
      detail:
        "Refunded by Bridge: R03 Risk Rejection (Third Party Payment), ref rref_123",
      context: expect.objectContaining({
        event_id: "wh_refund",
        state: "refunded",
        customer_id: "cust_wire",
        deposit_id: "deposit_wire_5000",
        amount: "5000.0",
        refund_code: "R03",
        refund_reason: "Risk Rejection",
        risk_rejection_reason: "Third Party Payment",
        refund_reference_id: "rref_123",
        originator_name: "ACME HOLDINGS LLC",
        payment_rail: "wire",
      }),
    })
  })

  it("posts a red refund event to the ops feed instead of deposit succeeded", async () => {
    await depositHandler(makeReq(bodyFor(refundedObject)), makeRes())

    expect(notifyOpsEvent).toHaveBeenCalledTimes(1)
    expect(notifyOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        flow: "deposit",
        phase: "refunded",
        status: "failed",
        amount: { value: "5000.0", currency: "usd" },
        meta: expect.objectContaining({
          customerId: "cust_wire",
          depositId: "deposit_wire_5000",
          refundCode: "R03",
          originator: "ACME HOLDINGS LLC",
        }),
      }),
    )
  })

  it("pages (critical) when the refund itself failed", async () => {
    await depositHandler(
      makeReq(bodyFor({ ...refundedObject, type: "refund_failed" })),
      makeRes(),
    )

    expect(alertBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "critical",
        dedupKey: "bridge-webhook:deposit-not-delivered:deposit_wire_5000:refund_failed",
      }),
    )
  })

  it("informs on refund_in_flight with an amber ops event", async () => {
    await depositHandler(
      makeReq(bodyFor({ ...refundedObject, type: "refund_in_flight" })),
      makeRes(),
    )

    expect(alertBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "warning",
        title: "Bridge deposit being refunded: 5000.0 USD",
      }),
    )
    expect(notifyOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "refund-in-flight", status: "pending" }),
    )
  })

  it("does not alert again for a duplicate delivery", async () => {
    mockLockIdempotencyKey.mockResolvedValue(new Error("already locked"))

    await depositHandler(makeReq(bodyFor(refundedObject)), makeRes())

    expect(alertBridge).not.toHaveBeenCalled()
    expect(notifyOpsEvent).not.toHaveBeenCalled()
  })

  it("keeps the success event and raises no alert for a normal deposit", async () => {
    await depositHandler(
      makeReq(bodyFor({ ...refundedObject, type: "funds_received", refund: undefined })),
      makeRes(),
    )

    expect(alertBridge).not.toHaveBeenCalled()
    expect(notifyOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "succeeded", status: "success" }),
    )
  })
})
