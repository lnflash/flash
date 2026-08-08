import { Request, Response } from "express"

const mockFygaroConfig = {
  enabled: true,
  webhook: { port: 4010, secrets: {}, timestampSkewMs: 300000 },
  credit: { enabled: false },
}

jest.mock("@config", () => ({
  get FygaroConfig() {
    return mockFygaroConfig
  },
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock("@services/lock", () => ({
  LockService: jest.fn(() => ({
    lockIdempotencyKey: (...args: unknown[]) => mockLockIdempotencyKey(...args),
    lockPaymentIdempotencyKey: (key: unknown, fn: unknown) =>
      mockLockPaymentIdempotencyKey(key, fn),
  })),
}))

jest.mock("@services/mongoose", () => ({
  AccountsRepository: () => ({
    findByUsername: (...args: unknown[]) => mockFindByUsername(...args),
  }),
}))

jest.mock("@services/frappe/BridgeTransferRequestWriter", () => ({
  writeFygaroTopupRequest: (...args: unknown[]) => mockWriteFygaroTopup(...args),
  completeFygaroTopup: (...args: unknown[]) => mockCompleteFygaroTopup(...args),
  isFygaroTopupCompleted: (...args: unknown[]) => mockIsFygaroTopupCompleted(...args),
}))

jest.mock("@services/alerts", () => ({
  alertBridge: (...args: unknown[]) => mockAlertBridge(...args),
  generateDedupKey: new Proxy({}, { get: () => jest.fn(() => "dedup") }),
}))

jest.mock("@services/alerts/ops-events", () => ({
  notifyOpsEvent: (...args: unknown[]) => mockNotifyOpsEvent(...args),
}))

jest.mock("@services/fygaro/webhook-server/credit-topup", () => {
  class FygaroCreditError extends Error {
    step: string
    constructor(step: string, message: string) {
      super(message)
      this.name = "FygaroCreditError"
      this.step = step
    }
  }
  return {
    FygaroCreditError,
    creditFygaroTopup: (...args: unknown[]) => mockCreditFygaroTopup(...args),
  }
})

const mockLockIdempotencyKey = jest.fn()
const mockLockPaymentIdempotencyKey = jest.fn()
const mockFindByUsername = jest.fn()
const mockWriteFygaroTopup = jest.fn()
const mockCompleteFygaroTopup = jest.fn()
const mockIsFygaroTopupCompleted = jest.fn()
const mockAlertBridge = jest.fn()
const mockNotifyOpsEvent = jest.fn()
const mockCreditFygaroTopup = jest.fn()

import { ResourceAttemptsLockServiceError } from "@domain/lock"

import { paymentHandler } from "@services/fygaro/webhook-server/routes/payment"
import { FygaroCreditError } from "@services/fygaro/webhook-server/credit-topup"

const ACCOUNT_ID = "account-1" as AccountId
const WALLET_ID = "wallet-1" as WalletId

const VALID_BODY = {
  transactionId: "0e2f2c1a-6f6e-4f2b-9b1e-3f1a2b3c4d5e",
  reference: "FG-1042",
  customReference: "civilizedbarbarian",
  amount: "10.00",
  currency: "USD",
  authCode: null,
  createdAt: "2026-08-07T15:00:00Z",
  client: { name: "Regina Bailey", email: "regina@example.com" },
}

const makeRes = (): Response => {
  const res = { status: jest.fn(), json: jest.fn() } as unknown as Response
  ;(res.status as jest.Mock).mockReturnValue(res)
  ;(res.json as jest.Mock).mockReturnValue(res)
  return res
}

const makeReq = (body: Record<string, unknown>): Request =>
  ({ body }) as unknown as Request

beforeEach(() => {
  jest.clearAllMocks()
  mockFygaroConfig.credit = { enabled: false }
  mockLockIdempotencyKey.mockResolvedValue(true)
  // Releasing lock: default to acquiring and running the wrapped callback.
  mockLockPaymentIdempotencyKey.mockImplementation(
    async (_key: unknown, fn: () => Promise<unknown>) => fn(),
  )
  mockIsFygaroTopupCompleted.mockResolvedValue(false)
  mockFindByUsername.mockResolvedValue({ id: ACCOUNT_ID })
  mockWriteFygaroTopup.mockResolvedValue(true)
  mockCompleteFygaroTopup.mockResolvedValue(true)
  mockCreditFygaroTopup.mockResolvedValue({ walletId: WALLET_ID, status: "success" })
})

describe("fygaro paymentHandler", () => {
  it("rejects a payload without transactionId or amount with 400", async () => {
    const res = makeRes()

    await paymentHandler(makeReq({ amount: "10.00" }), res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(mockWriteFygaroTopup).not.toHaveBeenCalled()
  })

  it("records an attributed payment and reports pending when credit is disabled", async () => {
    const res = makeRes()

    await paymentHandler(makeReq(VALID_BODY), res)

    expect(mockWriteFygaroTopup).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: VALID_BODY.transactionId,
        amount: "10.00",
        currency: "USD",
        accountId: ACCOUNT_ID,
      }),
    )
    expect(mockCreditFygaroTopup).not.toHaveBeenCalled()
    expect(mockNotifyOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "fygaro-recorded", status: "pending" }),
    )
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ status: "recorded", credited: false })
  })

  it("still records a payment with a blank customReference and alerts as unattributed", async () => {
    const res = makeRes()

    await paymentHandler(makeReq({ ...VALID_BODY, customReference: "" }), res)

    expect(mockFindByUsername).not.toHaveBeenCalled()
    expect(mockWriteFygaroTopup).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: undefined }),
    )
    expect(mockAlertBridge).toHaveBeenCalledWith(
      expect.objectContaining({ severity: "warning" }),
    )
    expect(mockNotifyOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "fygaro-unattributed", status: "pending" }),
    )
    expect(res.json).toHaveBeenCalledWith({ status: "recorded", attributed: false })
  })

  it("treats an unknown username as unattributed", async () => {
    mockFindByUsername.mockResolvedValue(new Error("CouldNotFindError"))
    const res = makeRes()

    await paymentHandler(makeReq(VALID_BODY), res)

    expect(mockWriteFygaroTopup).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: undefined }),
    )
    expect(res.json).toHaveBeenCalledWith({ status: "recorded", attributed: false })
  })

  it("returns 500 when the ERPNext audit write fails so Fygaro retries", async () => {
    mockWriteFygaroTopup.mockResolvedValue(new Error("erpnext down"))
    const res = makeRes()

    await paymentHandler(makeReq(VALID_BODY), res)

    expect(mockAlertBridge).toHaveBeenCalledWith(
      expect.objectContaining({ severity: "critical" }),
    )
    expect(res.status).toHaveBeenCalledWith(500)
    expect(mockLockIdempotencyKey).not.toHaveBeenCalled()
  })

  it("acknowledges a duplicate record-only delivery without reprocessing", async () => {
    mockLockIdempotencyKey.mockResolvedValue(new Error("already locked"))
    const res = makeRes()

    await paymentHandler(makeReq(VALID_BODY), res)

    expect(mockNotifyOpsEvent).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ status: "already_processed" })
  })

  it("dedupes re-deliveries of an unattributed payment before emitting the ops event", async () => {
    mockLockIdempotencyKey.mockResolvedValue(new Error("already locked"))
    const res = makeRes()

    await paymentHandler(makeReq({ ...VALID_BODY, customReference: "" }), res)

    expect(mockNotifyOpsEvent).not.toHaveBeenCalled()
    expect(mockAlertBridge).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({ status: "already_processed" })
  })

  describe("with credit enabled", () => {
    beforeEach(() => {
      mockFygaroConfig.credit = { enabled: true }
    })

    it("credits the account in cents and promotes the audit row to Completed", async () => {
      const res = makeRes()

      await paymentHandler(makeReq(VALID_BODY), res)

      expect(mockCreditFygaroTopup).toHaveBeenCalledWith({
        recipientAccountId: ACCOUNT_ID,
        amountCents: 1000,
        transactionId: VALID_BODY.transactionId,
      })
      expect(mockCompleteFygaroTopup).toHaveBeenCalledWith(
        expect.objectContaining({
          transactionId: VALID_BODY.transactionId,
          accountId: ACCOUNT_ID,
          walletId: WALLET_ID,
        }),
      )
      expect(mockNotifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({ phase: "succeeded", status: "success" }),
      )
      expect(res.json).toHaveBeenCalledWith({ status: "success", credited: true })
    })

    it("records without crediting and alerts critical when the credit fails", async () => {
      mockCreditFygaroTopup.mockResolvedValue(
        new FygaroCreditError("intraledger-send", "insufficient balance"),
      )
      const res = makeRes()

      await paymentHandler(makeReq(VALID_BODY), res)

      expect(mockCompleteFygaroTopup).not.toHaveBeenCalled()
      expect(mockAlertBridge).toHaveBeenCalledWith(
        expect.objectContaining({ severity: "critical" }),
      )
      expect(mockNotifyOpsEvent).toHaveBeenCalledWith(
        expect.objectContaining({ status: "failed", step: "credit:intraledger-send" }),
      )
      expect(res.status).toHaveBeenCalledWith(200)
      expect(res.json).toHaveBeenCalledWith({ status: "recorded", credited: false })
    })

    it("short-circuits when the audit row is already Completed (processed re-delivery)", async () => {
      mockIsFygaroTopupCompleted.mockResolvedValue(true)
      const res = makeRes()

      await paymentHandler(makeReq(VALID_BODY), res)

      expect(mockCreditFygaroTopup).not.toHaveBeenCalled()
      expect(mockCompleteFygaroTopup).not.toHaveBeenCalled()
      expect(res.json).toHaveBeenCalledWith({ status: "already_processed" })
    })

    it("re-runs the credit when a retry arrives after an incomplete first attempt", async () => {
      // Row still Fiat Received (crash or promotion failure last time):
      // the credit path must run again — withPaymentIdempotency makes the
      // send replay-safe — so the retry self-heals instead of stranding.
      mockIsFygaroTopupCompleted.mockResolvedValue(false)
      const res = makeRes()

      await paymentHandler(makeReq(VALID_BODY), res)

      expect(mockCreditFygaroTopup).toHaveBeenCalledTimes(1)
      expect(mockCompleteFygaroTopup).toHaveBeenCalledTimes(1)
      expect(res.json).toHaveBeenCalledWith({ status: "success", credited: true })
    })

    it("acknowledges without crediting when another delivery holds the credit lock", async () => {
      mockLockPaymentIdempotencyKey.mockResolvedValue(
        new ResourceAttemptsLockServiceError(),
      )
      const res = makeRes()

      await paymentHandler(makeReq(VALID_BODY), res)

      expect(mockCreditFygaroTopup).not.toHaveBeenCalled()
      expect(res.status).toHaveBeenCalledWith(200)
      expect(res.json).toHaveBeenCalledWith({ status: "already_processing" })
    })

    it("returns 500 with a critical alert when the credit block threw (not contention)", async () => {
      // redlock reports a swallowed callback throw as a generic lock error —
      // that must NOT be acked as already_processing, or Fygaro stops
      // retrying and the payment strands at Fiat Received silently.
      mockLockPaymentIdempotencyKey.mockResolvedValue(
        new Error("UnknownLockServiceError"),
      )
      const res = makeRes()

      await paymentHandler(makeReq(VALID_BODY), res)

      expect(mockAlertBridge).toHaveBeenCalledWith(
        expect.objectContaining({ severity: "critical" }),
      )
      expect(res.status).toHaveBeenCalledWith(500)
    })

    it("never auto-credits a non-USD payment", async () => {
      const res = makeRes()

      await paymentHandler(makeReq({ ...VALID_BODY, currency: "JMD" }), res)

      expect(mockCreditFygaroTopup).not.toHaveBeenCalled()
      expect(mockAlertBridge).toHaveBeenCalledWith(
        expect.objectContaining({ severity: "warning" }),
      )
      expect(res.json).toHaveBeenCalledWith({ status: "recorded", credited: false })
    })

    it("still reports success when only the ERPNext promotion fails after a credit", async () => {
      mockCompleteFygaroTopup.mockResolvedValue(new Error("erpnext down"))
      const res = makeRes()

      await paymentHandler(makeReq(VALID_BODY), res)

      expect(mockAlertBridge).toHaveBeenCalledWith(
        expect.objectContaining({ severity: "warning" }),
      )
      expect(res.json).toHaveBeenCalledWith({ status: "success", credited: true })
    })
  })
})
