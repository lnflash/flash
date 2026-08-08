import { Request, Response } from "express"

const mockFygaroConfig = { enabled: false }

jest.mock("@config", () => ({
  get FygaroConfig() {
    return mockFygaroConfig
  },
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import { fygaroEnabledGuard } from "@services/fygaro/webhook-server/middleware/enabled-guard"

const makeRes = (): Response => {
  const res = { status: jest.fn(), json: jest.fn() } as unknown as Response
  ;(res.status as jest.Mock).mockReturnValue(res)
  ;(res.json as jest.Mock).mockReturnValue(res)
  return res
}

const makeReq = (path: string): Request => ({ path }) as unknown as Request

beforeEach(() => {
  jest.clearAllMocks()
  mockFygaroConfig.enabled = false
})

describe("fygaroEnabledGuard", () => {
  it("rejects non-health routes with 503 while disabled", () => {
    const res = makeRes()
    const next = jest.fn()

    fygaroEnabledGuard(makeReq("/payment"), res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(503)
  })

  it("lets /health through while disabled (k8s probes)", () => {
    const res = makeRes()
    const next = jest.fn()

    fygaroEnabledGuard(makeReq("/health"), res, next)

    expect(next).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
  })

  it("lets all routes through when enabled", () => {
    mockFygaroConfig.enabled = true
    const res = makeRes()
    const next = jest.fn()

    fygaroEnabledGuard(makeReq("/payment"), res, next)

    expect(next).toHaveBeenCalled()
  })
})
