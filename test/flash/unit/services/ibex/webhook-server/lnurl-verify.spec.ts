jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: { invoiceFromHash: jest.fn() },
}))
jest.mock("@config", () => ({
  IbexConfig: { webhook: { uri: "https://ibex.test.flashapp.me", secret: "s" } },
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
jest.mock("@services/mongoose/wallets", () => ({ WalletsRepository: jest.fn() }))
jest.mock("@services/mongoose/zap-request", () => ({ ZapRequestModel: jest.fn() }))
jest.mock("@services/mongoose", () => ({ AccountsRepository: jest.fn() }))
jest.mock("@utils", () => ({ extractPaymentHashFromBolt11: jest.fn() }))
jest.mock("../../../../../../src/services/ibex/webhook-server/middleware", () => ({
  authenticate: jest.fn(),
  logRequest: jest.fn(),
  validateIbexIp: jest.fn(),
}))

import { Request, Response } from "express"

const mockInvoiceFromHash = jest.requireMock("@services/ibex/client").default
  .invoiceFromHash as jest.Mock

import {
  lnurlVerifyHandler,
  buildVerifyUrl,
} from "@services/ibex/webhook-server/routes/on-pay"

const HASH = "a".repeat(64)

const makeRes = () => {
  const res = { status: jest.fn(), json: jest.fn() } as unknown as Response
  ;(res.status as jest.Mock).mockReturnValue(res)
  ;(res.json as jest.Mock).mockReturnValue(res)
  return res
}
const makeReq = (paymentHash?: string) =>
  ({ params: { paymentHash } }) as unknown as Request

describe("LUD-21 lnurlVerifyHandler", () => {
  afterEach(() => jest.clearAllMocks())

  it("returns settled=true with preimage for a settled invoice", async () => {
    mockInvoiceFromHash.mockResolvedValue({
      bolt11: "lnbc1...",
      preImage: "deadbeef",
      settleDateUtc: "2026-07-07T12:00:00Z",
      state: { id: 1, name: "SETTLED" },
    })
    const res = makeRes()
    await lnurlVerifyHandler(makeReq(HASH), res)
    expect(res.json).toHaveBeenCalledWith({
      status: "OK",
      settled: true,
      preimage: "deadbeef",
      pr: "lnbc1...",
    })
  })

  it("returns settled=false with null preimage for an open invoice", async () => {
    mockInvoiceFromHash.mockResolvedValue({
      bolt11: "lnbc1...",
      preImage: "",
      settleDateUtc: "",
      state: { id: 0, name: "OPEN" },
    })
    const res = makeRes()
    await lnurlVerifyHandler(makeReq(HASH), res)
    expect(res.json).toHaveBeenCalledWith({
      status: "OK",
      settled: false,
      preimage: null,
      pr: "lnbc1...",
    })
  })

  it("404s LUD-21-style for an unknown hash (IBEX error)", async () => {
    mockInvoiceFromHash.mockResolvedValue(new Error("not found"))
    const res = makeRes()
    await lnurlVerifyHandler(makeReq(HASH), res)
    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith({ status: "ERROR", reason: "Not found" })
  })

  it("404s without calling IBEX for a malformed hash", async () => {
    const res = makeRes()
    await lnurlVerifyHandler(makeReq("nope"), res)
    expect(mockInvoiceFromHash).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(404)
  })

  it("builds the verify URL from the webhook base", () => {
    expect(buildVerifyUrl(HASH)).toBe(
      `https://ibex.test.flashapp.me/pay/lnurl/verify/${HASH}`,
    )
  })
})
