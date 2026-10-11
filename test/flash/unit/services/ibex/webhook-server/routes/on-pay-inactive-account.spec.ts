jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: { decodeLnurl: jest.fn(), invoiceFromHash: jest.fn() },
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

import { AccountsRepository } from "@services/mongoose"
import { WalletsRepository } from "@services/mongoose/wallets"
import Ibex from "@services/ibex/client"
import { router } from "@services/ibex/webhook-server/routes/on-pay"
import { ibexWebhookPaths } from "@services/ibex/webhook-config"
import { AccountStatus } from "@domain/accounts"

const decodeLnurl = Ibex.decodeLnurl as jest.Mock

// Same lookup as the ssrf spec: the handler under test is the last handle on
// the lnurl layer (rate-limit / cors / logRequest are mounted ahead of it and
// are exercised separately).
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

const mockAccount = (status: string) => {
  ;(AccountsRepository as jest.Mock).mockReturnValue({
    findByUsername: jest.fn().mockResolvedValue({
      id: "a1",
      status,
      defaultWalletId: "w1",
    }),
  })
  ;(WalletsRepository as jest.Mock).mockReturnValue({
    findById: jest.fn().mockResolvedValue({ lnurlp: "lnurl1usercontrolled" }),
  })
}

describe("GET /pay/lnurl/:username — inactive accounts", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  // Only `active` may receive. Everything else has to short-circuit before any
  // IBEX call: the whole point of the guard is that an unusable account does
  // not get an invoice minted against it.
  it.each([
    ["new", AccountStatus.New],
    ["pending", AccountStatus.Pending],
    ["locked", AccountStatus.Locked],
    ["closed", AccountStatus.Closed],
  ])(
    "answers a LNURL error for a %s account and never touches IBEX",
    async (_name, status) => {
      mockAccount(status)
      decodeLnurl.mockResolvedValue({ decodedLnurl: "https://pay.example.com/lnurl" })

      const res = makeRes()
      await lnurlHandler()(makeReq(), res)

      expect(res.json).toHaveBeenCalledWith({
        status: "ERROR",
        reason: "Account is inactive",
      })
      expect(decodeLnurl).not.toHaveBeenCalled()
    },
  )

  it("still serves an active account", async () => {
    mockAccount(AccountStatus.Active)
    decodeLnurl.mockRejectedValue(new Error("stop after the status check"))

    const res = makeRes()
    await lnurlHandler()(makeReq(), res)

    expect(decodeLnurl).toHaveBeenCalledTimes(1)
    expect(res.json).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: "Account is inactive" }),
    )
  })
})
