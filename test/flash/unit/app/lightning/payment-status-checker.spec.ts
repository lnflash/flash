jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: { invoiceFromHash: jest.fn() },
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
jest.mock("@domain/bitcoin/lightning", () => ({
  ...jest.requireActual("@domain/bitcoin/lightning"),
  decodeInvoice: jest.fn(),
}))

import { ApiError } from "ibex-client"

import { PaymentStatusChecker } from "@app/lightning/payment-status-checker"
import { IbexError } from "@services/ibex/errors"

const mockInvoiceFromHash = jest.requireMock("@services/ibex/client").default
  .invoiceFromHash as jest.Mock
const mockDecodeInvoice = jest.requireMock("@domain/bitcoin/lightning")
  .decodeInvoice as jest.Mock

const PAYMENT_HASH = "b568463e07106d12fe406b2a1069bdc67ee4a6e67b4227934e8a7bed4d6e853b"
const PAYMENT_REQUEST = "lnbc1fakerequest"

const ibexErrorWithHttpCode = (httpCode: number): IbexError =>
  new IbexError(new ApiError(Object.assign(new Error(`http ${httpCode}`), { status: httpCode })))

const decodedInvoice = ({ isExpired }: { isExpired: boolean }) => ({
  paymentHash: PAYMENT_HASH,
  expiresAt: new Date(Date.now() + (isExpired ? -1 : +1) * 60 * 60 * 1000),
  isExpired,
})

const checkerWith = async ({ isExpired }: { isExpired: boolean }) => {
  mockDecodeInvoice.mockReturnValue(decodedInvoice({ isExpired }))
  const checker = await PaymentStatusChecker(PAYMENT_REQUEST)
  if (checker instanceof Error) throw checker
  return checker
}

beforeEach(() => {
  mockInvoiceFromHash.mockReset()
  mockDecodeInvoice.mockReset()
})

describe("PaymentStatusChecker", () => {
  it("returns the decode error for an invalid payment request", async () => {
    const decodeError = new Error("invalid invoice")
    mockDecodeInvoice.mockReturnValue(decodeError)
    const checker = await PaymentStatusChecker("not-an-invoice")
    expect(checker).toBe(decodeError)
  })

  it("queries IBEX by the decoded payment hash", async () => {
    const checker = await checkerWith({ isExpired: false })
    mockInvoiceFromHash.mockResolvedValue({ state: { id: 1 } })
    await checker.status()
    expect(mockInvoiceFromHash).toHaveBeenCalledWith(PAYMENT_HASH)
  })

  describe("status", () => {
    it("returns PAID when IBEX reports the invoice settled", async () => {
      const checker = await checkerWith({ isExpired: false })
      mockInvoiceFromHash.mockResolvedValue({ state: { id: 1, name: "SETTLED" } })
      expect(await checker.status()).toBe("PAID")
    })

    it("returns PAID for a settled invoice even after its expiry has passed", async () => {
      const checker = await checkerWith({ isExpired: true })
      mockInvoiceFromHash.mockResolvedValue({ state: { id: 1, name: "SETTLED" } })
      expect(await checker.status()).toBe("PAID")
    })

    it("returns PENDING for an unsettled, unexpired invoice", async () => {
      const checker = await checkerWith({ isExpired: false })
      mockInvoiceFromHash.mockResolvedValue({ state: { id: 0, name: "OPEN" } })
      expect(await checker.status()).toBe("PENDING")
    })

    it("returns EXPIRED for an unsettled invoice past its expiry", async () => {
      const checker = await checkerWith({ isExpired: true })
      mockInvoiceFromHash.mockResolvedValue({ state: { id: 2, name: "EXPIRED" } })
      expect(await checker.status()).toBe("EXPIRED")
    })

    it("returns EXPIRED when IBEX 404s an invoice past its expiry (purged invoice)", async () => {
      const checker = await checkerWith({ isExpired: true })
      mockInvoiceFromHash.mockResolvedValue(ibexErrorWithHttpCode(404))
      expect(await checker.status()).toBe("EXPIRED")
    })

    it("returns the error when IBEX 404s an invoice that has not expired", async () => {
      const checker = await checkerWith({ isExpired: false })
      const err = ibexErrorWithHttpCode(404)
      mockInvoiceFromHash.mockResolvedValue(err)
      expect(await checker.status()).toBe(err)
    })

    it("returns the error for a non-404 IBEX failure even when expired", async () => {
      const checker = await checkerWith({ isExpired: true })
      const err = ibexErrorWithHttpCode(500)
      mockInvoiceFromHash.mockResolvedValue(err)
      expect(await checker.status()).toBe(err)
    })

    it("returns the error for an IBEX failure without an http code even when expired", async () => {
      const checker = await checkerWith({ isExpired: true })
      const err = new IbexError(new Error("connection reset"))
      mockInvoiceFromHash.mockResolvedValue(err)
      expect(await checker.status()).toBe(err)
    })
  })
})
