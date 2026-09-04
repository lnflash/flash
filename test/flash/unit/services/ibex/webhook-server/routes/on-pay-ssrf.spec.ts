jest.mock("dns", () => ({
  promises: { lookup: jest.fn() },
}))
jest.mock("axios", () => ({
  __esModule: true,
  default: { get: jest.fn() },
}))
jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: { decodeLnurl: jest.fn(), invoiceFromHash: jest.fn() },
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

import dns from "dns"

import { Request, Response } from "express"
import axios from "axios"

import { AccountsRepository } from "@services/mongoose"
import { WalletsRepository } from "@services/mongoose/wallets"
import { LnurlInvoiceModel } from "@services/mongoose/lnurl-invoice"
import Ibex from "@services/ibex/client"
import { router } from "@services/ibex/webhook-server/routes/on-pay"
import { ibexWebhookPaths } from "@services/ibex/webhook-config"
import { extractPaymentHashFromBolt11 } from "@utils"

const lookup = dns.promises.lookup as jest.Mock
const axiosGet = axios.get as jest.Mock
const decodeLnurl = Ibex.decodeLnurl as jest.Mock

// The route handler is the last function on the GET /pay/lnurl/:username
// layer (rate-limit/cors/logRequest run ahead of it in production; unit-tested
// separately).
const lnurlHandler = (): ((req: Request, res: Response) => Promise<void>) => {
  const layer = (
    router.stack as unknown as {
      route?: { path: string; stack: { handle: unknown }[] }
    }[]
  )
    .map((l) => l.route)
    .find((r) => r !== undefined && r.path === ibexWebhookPaths.onPay.lnurl)
  if (!layer) throw new Error("lnurl route not mounted")
  return layer.stack[layer.stack.length - 1].handle as (
    req: Request,
    res: Response,
  ) => Promise<void>
}

const makeReq = (): Request =>
  ({
    params: { username: "alice" },
    query: { amount: "1000" },
  }) as unknown as Request

const makeRes = () => {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  }
  return res as unknown as Response & { status: jest.Mock; json: jest.Mock }
}

const PUBLIC_ADDR = [{ address: "93.184.216.34", family: 4 }]

describe("GET /pay/lnurl/:username — SSRF guard wiring", () => {
  const savedNetwork = process.env.NETWORK

  beforeEach(() => {
    jest.clearAllMocks()
    process.env.NETWORK = "mainnet"
    lookup.mockResolvedValue(PUBLIC_ADDR)
    ;(AccountsRepository as jest.Mock).mockReturnValue({
      findByUsername: jest.fn().mockResolvedValue({ defaultWalletId: "w1" }),
    })
    ;(WalletsRepository as jest.Mock).mockReturnValue({
      findById: jest.fn().mockResolvedValue({ lnurlp: "lnurl1usercontrolled" }),
    })
  })

  afterAll(() => {
    if (savedNetwork === undefined) {
      delete process.env.NETWORK
    } else {
      process.env.NETWORK = savedNetwork
    }
  })

  it("blocks a user-supplied lnurlp that decodes to cloud metadata — axios is never called", async () => {
    decodeLnurl.mockResolvedValue({
      decodedLnurl: "http://169.254.169.254/latest/meta-data",
    })

    const res = makeRes()
    await lnurlHandler()(makeReq(), res as unknown as Response)

    expect(axiosGet).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(502)
    expect(LnurlInvoiceModel.create).not.toHaveBeenCalled()
  })

  it("blocks a user-supplied lnurlp that decodes to an internal RFC1918 address", async () => {
    decodeLnurl.mockResolvedValue({ decodedLnurl: "https://10.0.0.4/internal" })

    const res = makeRes()
    await lnurlHandler()(makeReq(), res as unknown as Response)

    expect(axiosGet).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(502)
  })

  it("blocks when the first hop is public but the invoice callback points inside", async () => {
    decodeLnurl.mockResolvedValue({ decodedLnurl: "https://pay.example.com/lnurl" })
    axiosGet.mockResolvedValueOnce({ data: { callback: "https://192.168.1.10/invoice" } })

    const res = makeRes()
    await lnurlHandler()(makeReq(), res as unknown as Response)

    expect(axiosGet).toHaveBeenCalledTimes(1) // first hop only
    expect(res.status).toHaveBeenCalledWith(502)
    expect(LnurlInvoiceModel.create).not.toHaveBeenCalled()
  })

  it("serves the invoice when both hops validate as public", async () => {
    decodeLnurl.mockResolvedValue({ decodedLnurl: "https://pay.example.com/lnurl" })
    axiosGet
      .mockResolvedValueOnce({
        data: { callback: "https://pay.example.com/invoice" },
      })
      .mockResolvedValueOnce({ data: { pr: "lnbc1invoice", successAction: null } })
    ;(extractPaymentHashFromBolt11 as jest.Mock).mockReturnValue("ab".repeat(32))

    const res = makeRes()
    await lnurlHandler()(makeReq(), res as unknown as Response)

    expect(axiosGet).toHaveBeenCalledTimes(2)
    expect(res.status).not.toHaveBeenCalledWith(502)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ pr: "lnbc1invoice" }))
  })
})
