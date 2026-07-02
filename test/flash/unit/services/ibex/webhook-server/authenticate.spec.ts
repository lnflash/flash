jest.mock("@config", () => ({
  IbexConfig: { webhook: { secret: "Kramerica" } },
}))

import { Request, Response } from "express"

import { authenticate } from "@services/ibex/webhook-server/middleware/authenticate"

const makeReq = (webhookSecret?: string) =>
  ({
    body: webhookSecret === undefined ? {} : { webhookSecret },
  }) as Request

const makeRes = () => {
  const res = {
    status: jest.fn().mockReturnThis(),
    end: jest.fn().mockReturnThis(),
  }
  return res as unknown as Response
}

describe("IBEX webhook authenticate middleware", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("accepts the configured webhook secret", () => {
    const res = makeRes()
    const next = jest.fn()

    authenticate(makeReq("Kramerica"), res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(res.status).not.toHaveBeenCalled()
  })

  it("rejects a same-length invalid secret", () => {
    const res = makeRes()
    const next = jest.fn()

    authenticate(makeReq("Kramerics"), res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.end).toHaveBeenCalledWith("Invalid secret")
  })

  it("rejects missing and different-length secrets without throwing", () => {
    for (const secret of [undefined, "short"]) {
      const res = makeRes()
      const next = jest.fn()

      authenticate(makeReq(secret), res, next)

      expect(next).not.toHaveBeenCalled()
      expect(res.status).toHaveBeenCalledWith(401)
      expect(res.end).toHaveBeenCalledWith("Invalid secret")
    }
  })

  it("fails closed when the webhook secret is unconfigured", () => {
    // The old `!==` compare passed when both sides were undefined (or both
    // empty), silently disabling auth on unconfigured deployments.
    const { IbexConfig } = jest.requireMock("@config")
    const configuredSecret = IbexConfig.webhook.secret

    try {
      for (const unconfigured of [undefined, ""]) {
        IbexConfig.webhook.secret = unconfigured

        for (const provided of [undefined, ""]) {
          const res = makeRes()
          const next = jest.fn()

          authenticate(makeReq(provided), res, next)

          expect(next).not.toHaveBeenCalled()
          expect(res.status).toHaveBeenCalledWith(401)
        }
      }
    } finally {
      IbexConfig.webhook.secret = configuredSecret
    }
  })
})
