jest.mock("@services/mongoose/accounts", () => ({
  AccountsRepository: jest.fn(),
}))

jest.mock("@services/lock", () => ({
  LockService: jest.fn(),
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock("@services/bridge", () => ({
  __esModule: true,
  default: {
    createVirtualAccount: jest.fn().mockResolvedValue({ virtualAccountId: "va-1" }),
  },
}))

jest.mock("@app/bridge/send-kyc-notification", () => ({
  isBridgeKycInitiated: (status: Account["bridgeKycStatus"]) =>
    status !== undefined && status !== null,
  sendBridgeKycNotificationBestEffort: jest.fn().mockResolvedValue(undefined),
  toBridgeKycNotificationOutcome: jest.fn((status) => {
    if (status === "approved") return "approved"
    if (status === "rejected") return "rejected"
    if (status === "offboarded") return "offboarded"
    if (status === "incomplete") return "incomplete"
    if (
      status === "under_review" ||
      status === "open" ||
      status === "awaiting_questionnaire" ||
      status === "awaiting_ubo" ||
      status === "paused"
    ) {
      return "in_review"
    }
    return null
  }),
}))

import { Request, Response } from "express"
import { kycHandler } from "@services/bridge/webhook-server/routes/kyc"
import { AccountsRepository } from "@services/mongoose/accounts"
import { LockService } from "@services/lock"
import { sendBridgeKycNotificationBestEffort } from "@app/bridge/send-kyc-notification"

const makeRes = () => {
  const res = { status: jest.fn(), json: jest.fn() } as unknown as Response
  ;(res.status as jest.Mock).mockReturnValue(res)
  ;(res.json as jest.Mock).mockReturnValue(res)
  return res
}

const makeReq = (body: Record<string, unknown>) => ({ body }) as unknown as Request

describe("kycHandler", () => {
  const accountId = "507f1f77bcf86cd799439011"
  const customerId = "cus_test_123"
  const mockAccount = {
    id: accountId,
    bridgeKycStatus: "incomplete",
  }

  beforeEach(() => {
    jest.clearAllMocks()
    ;(AccountsRepository as jest.Mock).mockReturnValue({
      findByBridgeCustomerId: jest.fn().mockResolvedValue(mockAccount),
      updateBridgeFields: jest.fn().mockResolvedValue(mockAccount),
    })
    ;(LockService as jest.Mock).mockReturnValue({
      lockIdempotencyKey: jest.fn().mockResolvedValue(true),
    })
  })

  it("sends a push notification when KYC is approved", async () => {
    const req = makeReq({
      event_id: "evt-approved",
      event_type: "customer.updated.status_transitioned",
      event_object: {
        id: customerId,
        status: "active",
      },
    })
    const res = makeRes()

    await kycHandler(req, res)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(sendBridgeKycNotificationBestEffort).toHaveBeenCalledWith({
      accountId,
      outcome: "approved",
      kycStatus: "approved",
      rejectionReasons: [],
    })
  })

  it("sends a push notification when KYC moves to under review", async () => {
    const req = makeReq({
      event_id: "evt-review",
      event_type: "customer.updated.status_transitioned",
      event_object: {
        id: customerId,
        status: "under_review",
      },
    })
    const res = makeRes()

    await kycHandler(req, res)

    expect(sendBridgeKycNotificationBestEffort).toHaveBeenCalledWith({
      accountId,
      outcome: "in_review",
      kycStatus: "under_review",
      rejectionReasons: [],
    })
  })

  it("sends a push notification when KYC is incomplete", async () => {
    ;(AccountsRepository as jest.Mock).mockReturnValue({
      findByBridgeCustomerId: jest.fn().mockResolvedValue({
        ...mockAccount,
        bridgeKycStatus: "open",
      }),
      updateBridgeFields: jest.fn().mockResolvedValue(mockAccount),
    })

    const req = makeReq({
      event_id: "evt-incomplete",
      event_type: "customer.updated.status_transitioned",
      event_object: {
        id: customerId,
        status: "incomplete",
      },
    })
    const res = makeRes()

    await kycHandler(req, res)

    expect(sendBridgeKycNotificationBestEffort).toHaveBeenCalledWith({
      accountId,
      outcome: "incomplete",
      kycStatus: "incomplete",
      rejectionReasons: [],
    })
  })

  it("does not send a push notification before KYC initiation", async () => {
    ;(AccountsRepository as jest.Mock).mockReturnValue({
      findByBridgeCustomerId: jest.fn().mockResolvedValue({
        ...mockAccount,
        bridgeKycStatus: undefined,
      }),
      updateBridgeFields: jest.fn().mockResolvedValue(mockAccount),
    })

    const req = makeReq({
      event_id: "evt-pre-init",
      event_type: "customer.updated.status_transitioned",
      event_object: {
        id: customerId,
        status: "under_review",
      },
    })
    const res = makeRes()

    await kycHandler(req, res)

    expect(sendBridgeKycNotificationBestEffort).not.toHaveBeenCalled()
  })

  it("does not send a push notification when the status is unchanged", async () => {
    ;(AccountsRepository as jest.Mock).mockReturnValue({
      findByBridgeCustomerId: jest.fn().mockResolvedValue({
        ...mockAccount,
        bridgeKycStatus: "approved",
      }),
      updateBridgeFields: jest.fn().mockResolvedValue(mockAccount),
    })

    const req = makeReq({
      event_id: "evt-approved-dup",
      event_type: "customer.updated.status_transitioned",
      event_object: {
        id: customerId,
        status: "active",
      },
    })
    const res = makeRes()

    await kycHandler(req, res)

    expect(sendBridgeKycNotificationBestEffort).not.toHaveBeenCalled()
  })

  it("sends a rejected notification with rejection reasons", async () => {
    const req = makeReq({
      event_id: "evt-rejected",
      event_type: "customer.updated.status_transitioned",
      event_object: {
        id: customerId,
        status: "rejected",
        rejection_reasons: [{ reason: "Document expired" }],
      },
    })
    const res = makeRes()

    await kycHandler(req, res)

    expect(sendBridgeKycNotificationBestEffort).toHaveBeenCalledWith({
      accountId,
      outcome: "rejected",
      kycStatus: "rejected",
      rejectionReasons: [{ reason: "Document expired" }],
    })
  })
})
