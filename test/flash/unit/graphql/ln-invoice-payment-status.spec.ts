jest.mock("@app", () => ({
  Lightning: { PaymentStatusChecker: jest.fn() },
}))
jest.mock("@services/logger", () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn(() => logger),
  }
  return { baseLogger: logger }
})

jest.mock("@services/pubsub", () => {
  const service = {
    publishDelayed: jest.fn(),
    publish: jest.fn(),
    createAsyncIterator: jest.fn().mockReturnValue("async-iterator"),
  }
  return { PubSubService: () => service, __service: service }
})

import LnInvoicePaymentStatusQuery from "@graphql/public/root/query/ln-invoice-payment-status"
import LnInvoicePaymentStatusSubscription from "@graphql/public/root/subscription/ln-invoice-payment-status"
import { IbexError } from "@services/ibex/errors"

const mockPaymentStatusChecker = jest.requireMock("@app").Lightning
  .PaymentStatusChecker as jest.Mock
const pubsubService = jest.requireMock("@services/pubsub").__service
const mockPublishDelayed = pubsubService.publishDelayed as jest.Mock
const mockPublish = pubsubService.publish as jest.Mock
const mockCreateAsyncIterator = pubsubService.createAsyncIterator as jest.Mock

const PAYMENT_REQUEST = "lnbc1fakerequest"

const checker = ({
  status,
  isExpired = false,
  expiresAt = new Date(Date.now() + 60 * 60 * 1000),
}: {
  status: string | Error
  isExpired?: boolean
  expiresAt?: Date
}) => ({
  paymentHash: "a".repeat(64),
  expiresAt,
  isExpired,
  status: jest.fn().mockResolvedValue(status),
})

beforeEach(() => {
  jest.clearAllMocks()
})

describe("lnInvoicePaymentStatus query", () => {
  const resolve = LnInvoicePaymentStatusQuery.resolve as (
    parent: unknown,
    args: { input: { paymentRequest: string | Error } },
  ) => Promise<{ errors: unknown[]; status: string }>

  it("returns the checker status", async () => {
    mockPaymentStatusChecker.mockResolvedValue(checker({ status: "PAID" }))
    const result = await resolve(undefined, { input: { paymentRequest: PAYMENT_REQUEST } })
    expect(result).toEqual({ errors: [], status: "PAID" })
  })

  it("returns EXPIRED for a purged, expired invoice instead of throwing", async () => {
    mockPaymentStatusChecker.mockResolvedValue(
      checker({ status: "EXPIRED", isExpired: true }),
    )
    const result = await resolve(undefined, { input: { paymentRequest: PAYMENT_REQUEST } })
    expect(result).toEqual({ errors: [], status: "EXPIRED" })
  })

  it("throws a mapped error when the status check fails", async () => {
    mockPaymentStatusChecker.mockResolvedValue(
      checker({ status: new IbexError(new Error("boom")) }),
    )
    await expect(
      resolve(undefined, { input: { paymentRequest: PAYMENT_REQUEST } }),
    ).rejects.toThrow()
  })

  it("throws when the payment request does not decode", async () => {
    mockPaymentStatusChecker.mockResolvedValue(new Error("invalid invoice"))
    await expect(
      resolve(undefined, { input: { paymentRequest: PAYMENT_REQUEST } }),
    ).rejects.toThrow()
  })
})

describe("lnInvoicePaymentStatus subscription", () => {
  const subscribe = LnInvoicePaymentStatusSubscription.subscribe as (
    source: unknown,
    args: { input: { paymentRequest: string | Error } },
  ) => Promise<unknown>

  it("publishes the terminal EXPIRED status for a purged, expired invoice", async () => {
    mockPaymentStatusChecker.mockResolvedValue(
      checker({ status: "EXPIRED", isExpired: true }),
    )
    const iterator = await subscribe(undefined, {
      input: { paymentRequest: PAYMENT_REQUEST },
    })
    expect(iterator).toBe("async-iterator")
    expect(mockPublishDelayed).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { status: "EXPIRED" } }),
    )
  })

  it("publishes only the error payload when the status check fails (no PAID)", async () => {
    mockPaymentStatusChecker.mockResolvedValue(
      checker({ status: new IbexError(new Error("boom")) }),
    )
    await subscribe(undefined, { input: { paymentRequest: PAYMENT_REQUEST } })
    expect(mockPublishDelayed).toHaveBeenCalledTimes(1)
    const payload = mockPublishDelayed.mock.calls[0][0].payload
    expect(payload.errors).toBeDefined()
    expect(payload.status).toBeUndefined()
  })

  it("publishes PAID when the invoice is settled", async () => {
    mockPaymentStatusChecker.mockResolvedValue(checker({ status: "PAID" }))
    await subscribe(undefined, { input: { paymentRequest: PAYMENT_REQUEST } })
    expect(mockPublishDelayed).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { status: "PAID" } }),
    )
  })

  it("publishes PENDING and arms the expiry timer for a live invoice", async () => {
    jest.useFakeTimers()
    try {
      const expiresAt = new Date(Date.now() + 5_000)
      mockPaymentStatusChecker.mockResolvedValue(
        checker({ status: "PENDING", expiresAt }),
      )
      await subscribe(undefined, { input: { paymentRequest: PAYMENT_REQUEST } })
      expect(mockPublishDelayed).toHaveBeenCalledWith(
        expect.objectContaining({ payload: { status: "PENDING" } }),
      )
      jest.advanceTimersByTime(7_000)
      expect(mockPublish).toHaveBeenCalledWith(
        expect.objectContaining({ payload: { status: "EXPIRED" } }),
      )
    } finally {
      jest.useRealTimers()
    }
  })

  it("does not arm an expiry timer for a terminal EXPIRED status", async () => {
    jest.useFakeTimers()
    try {
      mockPaymentStatusChecker.mockResolvedValue(
        checker({ status: "EXPIRED", isExpired: true }),
      )
      await subscribe(undefined, { input: { paymentRequest: PAYMENT_REQUEST } })
      jest.advanceTimersByTime(60 * 60 * 1000)
      expect(mockPublish).not.toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })
})
