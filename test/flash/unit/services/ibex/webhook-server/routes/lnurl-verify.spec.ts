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
jest.mock("@services/mongoose/lnurl-invoice", () => ({
  LnurlInvoiceModel: { exists: jest.fn(), create: jest.fn() },
}))
jest.mock("@services/mongoose", () => ({ AccountsRepository: jest.fn() }))
jest.mock("@utils", () => ({ extractPaymentHashFromBolt11: jest.fn() }))
jest.mock("@services/ibex/webhook-server/middleware", () => ({
  authenticate: jest.fn(),
  logRequest: jest.fn(),
  validateIbexIp: jest.fn(),
}))

import { Request, Response } from "express"

import {
  lnurlVerifyHandler,
  buildVerifyUrl,
} from "@services/ibex/webhook-server/routes/on-pay"

const mockInvoiceFromHash = jest.requireMock("@services/ibex/client").default
  .invoiceFromHash as jest.Mock
const mockExists = jest.requireMock("@services/mongoose/lnurl-invoice").LnurlInvoiceModel
  .exists as jest.Mock

// unique hash per test — the handler's settled-cache is module-level state
let hashCounter = 0
const freshHash = () => (++hashCounter).toString(16).padStart(4, "0").repeat(16)

const makeRes = () => {
  const res = { status: jest.fn(), json: jest.fn() } as unknown as Response
  ;(res.status as jest.Mock).mockReturnValue(res)
  ;(res.json as jest.Mock).mockReturnValue(res)
  return res
}
const makeReq = (paymentHash?: string) =>
  ({ params: { paymentHash } }) as unknown as Request

const NOT_FOUND = { status: "ERROR", reason: "Not found" }

describe("LUD-21 lnurlVerifyHandler", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockExists.mockResolvedValue({ _id: "x" })
  })

  it("returns settled=true with preimage for a settled invoice (state.id 1)", async () => {
    const HASH = freshHash()
    mockInvoiceFromHash.mockResolvedValue({
      bolt11: "lnbc1settled",
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
      pr: "lnbc1settled",
    })
  })

  it("suppresses a PRESENT preimage while the invoice is still open", async () => {
    const HASH = freshHash()
    // non-empty preImage on an OPEN invoice — the settled gate alone must
    // withhold it (IBEX generates invoices, so the preimage can pre-exist)
    mockInvoiceFromHash.mockResolvedValue({
      bolt11: "lnbc1open",
      preImage: "deadbeef",
      settleDateUtc: "",
      state: { id: 0, name: "OPEN" },
    })
    const res = makeRes()
    await lnurlVerifyHandler(makeReq(HASH), res)
    expect(res.json).toHaveBeenCalledWith({
      status: "OK",
      settled: false,
      preimage: null,
      pr: "lnbc1open",
    })
  })

  it("does NOT treat settleDateUtc alone as settled (strict state.id gate)", async () => {
    const HASH = freshHash()
    mockInvoiceFromHash.mockResolvedValue({
      bolt11: "lnbc1weird",
      preImage: "deadbeef",
      settleDateUtc: "2026-07-07T12:00:00Z",
      state: { id: 3, name: "ACCEPTED" },
    })
    const res = makeRes()
    await lnurlVerifyHandler(makeReq(HASH), res)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ settled: false, preimage: null }),
    )
  })

  it("refuses hashes not issued by this proxy, without calling IBEX", async () => {
    const HASH = freshHash()
    mockExists.mockResolvedValue(null)
    const res = makeRes()
    await lnurlVerifyHandler(makeReq(HASH), res)
    expect(mockInvoiceFromHash).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith(NOT_FOUND)
  })

  it("returns ERROR body for an IBEX-returned error", async () => {
    const HASH = freshHash()
    mockInvoiceFromHash.mockResolvedValue(new Error("not found"))
    const res = makeRes()
    await lnurlVerifyHandler(makeReq(HASH), res)
    expect(res.json).toHaveBeenCalledWith(NOT_FOUND)
  })

  it("returns ERROR body when the IBEX call REJECTS (network failure)", async () => {
    const HASH = freshHash()
    mockInvoiceFromHash.mockRejectedValue(new Error("ETIMEDOUT"))
    const res = makeRes()
    await lnurlVerifyHandler(makeReq(HASH), res)
    expect(res.json).toHaveBeenCalledWith(NOT_FOUND)
  })

  it("returns ERROR body when IBEX responds without a bolt11", async () => {
    const HASH = freshHash()
    mockInvoiceFromHash.mockResolvedValue({ state: { id: 1, name: "SETTLED" } })
    const res = makeRes()
    await lnurlVerifyHandler(makeReq(HASH), res)
    expect(res.json).toHaveBeenCalledWith(NOT_FOUND)
  })

  it("rejects malformed hashes before any lookup", async () => {
    const res = makeRes()
    await lnurlVerifyHandler(makeReq("nope"), res)
    expect(mockExists).not.toHaveBeenCalled()
    expect(mockInvoiceFromHash).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith(NOT_FOUND)
  })

  it("normalizes uppercase hashes to lowercase for lookups", async () => {
    const HASH = "ef".repeat(32) // letters, so toUpperCase() actually differs
    mockInvoiceFromHash.mockResolvedValue({
      bolt11: "lnbc1x",
      state: { id: 0, name: "OPEN" },
    })
    const res = makeRes()
    await lnurlVerifyHandler(makeReq(HASH.toUpperCase()), res)
    expect(mockExists).toHaveBeenCalledWith({ invoiceHash: HASH })
    expect(mockInvoiceFromHash).toHaveBeenCalledWith(HASH)
  })

  it("serves settled results from cache on repeat polls (single IBEX call)", async () => {
    const hash = freshHash()
    mockInvoiceFromHash.mockResolvedValue({
      bolt11: "lnbc1cached",
      preImage: "feedface",
      state: { id: 1, name: "SETTLED" },
    })
    const res1 = makeRes()
    await lnurlVerifyHandler(makeReq(hash), res1)
    const res2 = makeRes()
    await lnurlVerifyHandler(makeReq(hash), res2)
    expect(mockInvoiceFromHash).toHaveBeenCalledTimes(1)
    expect(res2.json).toHaveBeenCalledWith({
      status: "OK",
      settled: true,
      preimage: "feedface",
      pr: "lnbc1cached",
    })
  })

  it("never returns HTTP error statuses (LNURL 200+ERROR-body convention)", async () => {
    const HASH = freshHash()
    mockExists.mockResolvedValue(null)
    const res = makeRes()
    await lnurlVerifyHandler(makeReq(HASH), res)
    expect(res.status).not.toHaveBeenCalled()
  })

  it("builds the verify URL from the webhook base", () => {
    const HASH = freshHash()
    expect(buildVerifyUrl(HASH)).toBe(
      `https://ibex.test.flashapp.me/pay/lnurl/verify/${HASH}`,
    )
  })
})
