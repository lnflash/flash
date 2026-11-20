// ENG-889: a deposit Bridge puts under manual review, or a virtual account
// Bridge deactivates, must reach ops. Neither changes how the deposit row is
// written.

const mockCreateBridgeDeposit = jest.fn()
const mockWriteDepositRequest = jest.fn()
const mockLockIdempotencyKey = jest.fn()
const mockFindByBridgeCustomerId = jest.fn()

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

jest.mock("@services/mongoose/accounts", () => ({
  AccountsRepository: () => ({
    findByBridgeCustomerId: (...args: unknown[]) => mockFindByBridgeCustomerId(...args),
  }),
}))

jest.mock("@services/bridge/reconciliation", () => ({
  reconcileByTxHash: jest.fn().mockResolvedValue({ status: "matched" }),
}))

jest.mock("@services/frappe/BridgeTransferRequestWriter", () => ({
  writeBridgeDepositRequest: (...args: unknown[]) => mockWriteDepositRequest(...args),
}))

import { Request, Response } from "express"
import { CouldNotFindAccountError, UnknownRepositoryError } from "@domain/errors"
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

// Bridge's published in_review example (identifiers replaced).
const inReviewObject = {
  id: "va_event_review",
  type: "in_review",
  amount: "120.0",
  currency: "usd",
  customer_id: "cust_1",
  virtual_account_id: "va_1",
  deposit_id: "deposit_1",
  source: { payment_rail: "ach_push" },
}

const deactivationObject = {
  id: "va_event_deactivation",
  type: "deactivation",
  amount: "0.0",
  currency: "usd",
  customer_id: "cust_1",
  virtual_account_id: "va_1",
}

const bodyFor = (eventObject: Record<string, unknown>, eventId = "wh_1") => ({
  event_id: eventId,
  event_category: "virtual_account.activity",
  event_object: eventObject,
})

beforeEach(() => {
  jest.clearAllMocks()
  mockCreateBridgeDeposit.mockResolvedValue({ id: "log_1" })
  mockWriteDepositRequest.mockResolvedValue(true)
  mockLockIdempotencyKey.mockResolvedValue({})
  mockFindByBridgeCustomerId.mockResolvedValue({ id: "acct_1", username: "ziontill" })
})

describe("depositHandler: in_review", () => {
  it("alerts ops (warning) with customer, amount, deposit and the mapped account", async () => {
    const res = makeRes()
    await depositHandler(makeReq(bodyFor(inReviewObject)), res)

    expect(res.status as jest.Mock).toHaveBeenCalledWith(200)
    expect(mockFindByBridgeCustomerId).toHaveBeenCalledWith("cust_1")
    expect(alertBridge).toHaveBeenCalledTimes(1)
    expect(alertBridge).toHaveBeenCalledWith({
      dedupKey: "bridge-webhook:virtual-account:in_review:wh_1",
      source: "bridge-webhook",
      severity: "warning",
      title: "Bridge deposit under manual review: 120.0 USD, ziontill",
      detail:
        "Bridge is reviewing this deposit by hand. It is not delivered until the review ends.",
      context: expect.objectContaining({
        type: "in_review",
        customer_id: "cust_1",
        account_id: "acct_1",
        username: "ziontill",
        account_lookup: "found",
        deposit_id: "deposit_1",
        virtual_account_id: "va_1",
        amount: "120.0",
      }),
    })
  })

  it("posts an amber review event to the ops feed, not deposit succeeded", async () => {
    await depositHandler(makeReq(bodyFor(inReviewObject)), makeRes())

    expect(notifyOpsEvent).toHaveBeenCalledTimes(1)
    expect(notifyOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        flow: "deposit",
        phase: "in-review",
        status: "pending",
        accountId: "acct_1",
        amount: { value: "120.0", currency: "usd" },
      }),
    )
  })

  it("still writes the deposit row as before", async () => {
    await depositHandler(makeReq(bodyFor(inReviewObject)), makeRes())

    expect(mockWriteDepositRequest).toHaveBeenCalledTimes(1)
    expect(mockCreateBridgeDeposit).toHaveBeenCalledTimes(1)
  })

  it("does not alert again for a duplicate delivery", async () => {
    mockLockIdempotencyKey.mockResolvedValue(new Error("already locked"))

    await depositHandler(makeReq(bodyFor(inReviewObject)), makeRes())

    expect(alertBridge).not.toHaveBeenCalled()
  })

  it("alerts without an account when none is mapped, or the lookup fails", async () => {
    mockFindByBridgeCustomerId.mockResolvedValueOnce(new CouldNotFindAccountError())
    await depositHandler(makeReq(bodyFor(inReviewObject)), makeRes())
    expect((alertBridge as jest.Mock).mock.calls[0][0].context).toEqual(
      expect.objectContaining({ account_id: undefined, account_lookup: "not_found" }),
    )
    expect((alertBridge as jest.Mock).mock.calls[0][0].title).toContain("cust_1")

    mockFindByBridgeCustomerId.mockRejectedValueOnce(new Error("mongo down"))
    await depositHandler(makeReq(bodyFor(inReviewObject, "wh_2")), makeRes())
    expect((alertBridge as jest.Mock).mock.calls[1][0].context.account_lookup).toBe(
      "failed",
    )

    mockFindByBridgeCustomerId.mockResolvedValueOnce(new UnknownRepositoryError("down"))
    await depositHandler(makeReq(bodyFor(inReviewObject, "wh_3")), makeRes())
    expect((alertBridge as jest.Mock).mock.calls[2][0].context.account_lookup).toBe(
      "failed",
    )
  })
})

describe("depositHandler: deactivation", () => {
  it("alerts ops (warning) with no amount when Bridge sends 0.0", async () => {
    await depositHandler(makeReq(bodyFor(deactivationObject)), makeRes())

    expect(alertBridge).toHaveBeenCalledTimes(1)
    expect(alertBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupKey: "bridge-webhook:virtual-account:deactivation:wh_1",
        severity: "warning",
        title: "Bridge virtual account deactivated: ziontill",
        context: expect.objectContaining({
          type: "deactivation",
          customer_id: "cust_1",
          account_id: "acct_1",
          virtual_account_id: "va_1",
          amount: undefined,
        }),
      }),
    )
    expect(notifyOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "deactivation", status: "failed" }),
    )
  })

  it("still alerts when the event carries no amount at all", async () => {
    const noAmount: Record<string, unknown> = { ...deactivationObject }
    delete noAmount.amount
    const res = makeRes()

    await depositHandler(makeReq(bodyFor(noAmount)), res)

    expect(res.json as jest.Mock).toHaveBeenCalledWith({
      status: "skipped",
      reason: "missing_crediting_fields",
    })
    expect(mockWriteDepositRequest).not.toHaveBeenCalled()
    expect(alertBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupKey: "bridge-webhook:virtual-account:deactivation:wh_1",
        severity: "warning",
      }),
    )
  })
})

describe("depositHandler: other events", () => {
  it("does not alert on an ordinary deposit", async () => {
    await depositHandler(
      makeReq(bodyFor({ ...inReviewObject, type: "funds_received" })),
      makeRes(),
    )

    expect(alertBridge).not.toHaveBeenCalled()
    expect(mockFindByBridgeCustomerId).not.toHaveBeenCalled()
    expect(notifyOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "succeeded", status: "success" }),
    )
  })
})
