// The IBEX-custodial pay rail lifted out of lnInvoicePaymentSend. The
// idempotency wrapper is mocked to a faithful "authorize, then execute" so the
// spec can pin what this module hands it and in what order, without re-testing
// the wrapper (see idempotency.spec.ts for that).

const mockPayInvoice = jest.fn()
const mockWithPaymentIdempotency = jest.fn()

jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: { payInvoice: (...a: unknown[]) => mockPayInvoice(...a) },
}))
jest.mock("@app/payments/idempotency", () => ({
  withPaymentIdempotency: (...a: unknown[]) => mockWithPaymentIdempotency(...a),
}))
jest.mock("@services/tracing", () => ({
  addAttributesToCurrentSpan: jest.fn(),
  addEventToCurrentSpan: jest.fn(),
  recordExceptionInCurrentSpan: jest.fn(),
}))

import { PaymentSendStatus } from "@domain/bitcoin/lightning"
import { ValidationError } from "@domain/shared"
import { IbexError } from "@services/ibex/errors"
import { payLnInvoiceViaIbex } from "@app/payments/pay-invoice-via-ibex"

const WALLET_ID = "6a8203ce490716aa69381455" as WalletId
const ACCOUNT = { id: "6a8203ce490716aa69381454" } as unknown as Account
const PAYMENT_REQUEST = "lnbc401u1p-vendor-invoice"

const ibex200 = (statusId: number) => ({
  status: statusId,
  transaction: {
    id: "ibex-tx-1",
    payment: { hash: "a".repeat(64), statusId, status: { id: statusId } },
  },
})

type WrapperArgs = {
  idempotencyKey: string
  senderWalletId: string
  requestFingerprint: string
  authorize: () => Promise<true | Error>
  execute: () => Promise<unknown>
}

const pay = (overrides: Record<string, unknown> = {}) =>
  payLnInvoiceViaIbex({
    senderWalletId: WALLET_ID,
    senderAccount: ACCOUNT,
    paymentRequest: PAYMENT_REQUEST,
    idempotencyKey: "giftcard:order-1",
    requestFingerprint: `ln|${PAYMENT_REQUEST}|giftcard|order-1`,
    authorize: async () => true,
    ...overrides,
  })

beforeEach(() => {
  jest.clearAllMocks()
  // Faithful to the real wrapper's ordering on the execute path: the guard
  // runs first and a rejection short-circuits without executing.
  mockWithPaymentIdempotency.mockImplementation(async (args: WrapperArgs) => {
    const authorized = await args.authorize()
    if (authorized instanceof Error) return authorized
    return args.execute()
  })
  mockPayInvoice.mockResolvedValue(ibex200(2))
})

describe("payLnInvoiceViaIbex", () => {
  it("pays the bolt11 from the wallet's IBEX account and reports Success", async () => {
    const res = await pay()
    expect(res).toBe(PaymentSendStatus.Success)
    // The IBEX account id IS the Flash wallet id on this rail.
    expect(mockPayInvoice).toHaveBeenCalledWith({
      invoice: PAYMENT_REQUEST,
      accountId: WALLET_ID,
    })
  })

  it("reports Pending for an in-flight payment", async () => {
    mockPayInvoice.mockResolvedValue(ibex200(1))
    await expect(pay()).resolves.toBe(PaymentSendStatus.Pending)
  })

  it("reports Pending, not an error, for a response with no recognised status", async () => {
    mockPayInvoice.mockResolvedValue({})
    await expect(pay()).resolves.toBe(PaymentSendStatus.Pending)
  })

  it("passes an IbexError through as-is and does not call onResponse", async () => {
    const error = new IbexError(new Error("upstream 502"))
    mockPayInvoice.mockResolvedValue(error)
    const onResponse = jest.fn()
    const res = await pay({ onResponse })
    expect(res).toBe(error)
    expect(onResponse).not.toHaveBeenCalled()
  })

  it("hands the raw 200 to onResponse before reducing it to a status", async () => {
    const onResponse = jest.fn()
    await pay({ onResponse })
    expect(onResponse).toHaveBeenCalledTimes(1)
    expect(onResponse.mock.calls[0][0].transaction.id).toBe("ibex-tx-1")
  })

  describe("idempotency wrapper", () => {
    it("is handed the key, wallet, fingerprint and guard unchanged", async () => {
      const authorize = jest.fn(async () => true as const)
      await pay({ authorize })
      expect(mockWithPaymentIdempotency).toHaveBeenCalledTimes(1)
      const args = mockWithPaymentIdempotency.mock.calls[0][0] as WrapperArgs
      expect(args).toMatchObject({
        idempotencyKey: "giftcard:order-1",
        senderWalletId: WALLET_ID,
        requestFingerprint: `ln|${PAYMENT_REQUEST}|giftcard|order-1`,
      })
      expect(args.authorize).toBe(authorize)
      expect(typeof args.execute).toBe("function")
    })

    it("runs the guard inside the wrapper, before IBEX is called", async () => {
      const authorize = jest.fn(async () => true as const)
      await pay({ authorize })
      expect(authorize).toHaveBeenCalledTimes(1)
      expect(authorize.mock.invocationCallOrder[0]).toBeLessThan(
        mockPayInvoice.mock.invocationCallOrder[0],
      )
    })

    it("a guard rejection returns the error and never reaches IBEX", async () => {
      const rejection = new ValidationError("over limit")
      const res = await pay({ authorize: async () => rejection })
      expect(res).toBe(rejection)
      expect(mockPayInvoice).not.toHaveBeenCalled()
    })

    it("a replayed result never calls IBEX or onResponse: both live inside execute", async () => {
      // A wrapper that caches by key, like the real one: the first call runs
      // `execute`, the second returns the cached result without it. If this
      // module called IBEX or `onResponse` anywhere but inside `execute`, the
      // second call would show a second IBEX call or a second onResponse.
      const cache = new Map<string, unknown>()
      mockWithPaymentIdempotency.mockImplementation(async (args: WrapperArgs) => {
        const cached = cache.get(args.idempotencyKey)
        if (cached !== undefined) return cached
        const authorized = await args.authorize()
        if (authorized instanceof Error) return authorized
        const result = await args.execute()
        cache.set(args.idempotencyKey, result)
        return result
      })
      const onResponse = jest.fn()

      const first = await pay({ onResponse })
      expect(first).toBe(PaymentSendStatus.Success)
      expect(mockPayInvoice).toHaveBeenCalledTimes(1)
      expect(onResponse).toHaveBeenCalledTimes(1)

      const replay = await pay({ onResponse })
      expect(replay).toBe(PaymentSendStatus.Success)
      expect(mockPayInvoice).toHaveBeenCalledTimes(1)
      expect(onResponse).toHaveBeenCalledTimes(1)

      // A different key is a different payment and does execute.
      await pay({ onResponse, idempotencyKey: "giftcard:order-2" })
      expect(mockPayInvoice).toHaveBeenCalledTimes(2)
      expect(onResponse).toHaveBeenCalledTimes(2)
    })
  })
})
