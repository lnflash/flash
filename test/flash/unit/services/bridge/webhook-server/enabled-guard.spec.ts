const config = { enabled: true }

jest.mock("@config", () => ({
  get BridgeConfig() {
    return config
  },
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import { Request, Response } from "express"
import { bridgeEnabledGuard } from "@services/bridge/webhook-server/middleware/enabled-guard"

const makeRes = () => {
  const res = { status: jest.fn(), json: jest.fn() } as unknown as Response
  ;(res.status as jest.Mock).mockReturnValue(res)
  ;(res.json as jest.Mock).mockReturnValue(res)
  return res
}
const makeReq = (path: string) => ({ path }) as unknown as Request

describe("bridgeEnabledGuard (ENG-466)", () => {
  afterEach(() => {
    config.enabled = true
    jest.clearAllMocks()
  })

  it("passes webhook routes through when bridge is enabled", () => {
    const next = jest.fn()
    const res = makeRes()
    bridgeEnabledGuard(makeReq("/kyc"), res, next)
    expect(next).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
  })

  it("rejects mutating routes with 503 when bridge is disabled", () => {
    config.enabled = false
    const next = jest.fn()
    const res = makeRes()
    bridgeEnabledGuard(makeReq("/deposit"), res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(503)
    expect(res.json).toHaveBeenCalledWith({ error: "Bridge is disabled" })
  })

  it("always lets /health through, even when disabled (k8s probes)", () => {
    config.enabled = false
    const next = jest.fn()
    const res = makeRes()
    bridgeEnabledGuard(makeReq("/health"), res, next)
    expect(next).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
  })
})
