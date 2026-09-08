// A strong fixture: the weak-secret guard now also refuses anything under 32
// chars, so a short placeholder here would 503 before the comparison runs.
jest.mock("@config", () => ({
  IbexConfig: { webhook: { secret: "Kramerica-Industries-32-chars-plus" } },
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

import { Request, Response } from "express"

import {
  authenticate,
  warnIfIbexWebhookSecretWeak,
} from "@services/ibex/webhook-server/middleware/authenticate"
import { MIN_SECRET_LENGTH } from "@utils/weak-secrets"

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

    authenticate(makeReq("Kramerica-Industries-32-chars-plus"), res, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(res.status).not.toHaveBeenCalled()
  })

  it("rejects a same-length invalid secret", () => {
    const res = makeRes()
    const next = jest.fn()

    authenticate(makeReq("Kramerica-Industries-32-chars-pluX"), res, next)

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

  it("fails closed with 503 when the webhook secret is unconfigured", () => {
    // The old `!==` compare passed when both sides were undefined (or both
    // empty), silently disabling auth on unconfigured deployments.
    const { IbexConfig } = jest.requireMock("@config")
    const configuredSecret = IbexConfig.webhook.secret

    try {
      for (const unconfigured of [undefined, ""]) {
        IbexConfig.webhook.secret = unconfigured

        for (const provided of [undefined, "", unconfigured]) {
          const res = makeRes()
          const next = jest.fn()

          authenticate(makeReq(provided), res, next)

          expect(next).not.toHaveBeenCalled()
          expect(res.status).toHaveBeenCalledWith(503)
        }
      }
    } finally {
      IbexConfig.webhook.secret = configuredSecret
    }
  })

  // The 32-char floor is the half of the guard this PR adds, and the half an
  // operator is most likely to trip: a real, random, but short rotated value
  // looks configured everywhere except here.
  it("fails closed with 503 when the configured secret is shorter than the floor", () => {
    const { IbexConfig } = jest.requireMock("@config")
    const configuredSecret = IbexConfig.webhook.secret
    try {
      const short = "a".repeat(MIN_SECRET_LENGTH - 1)
      IbexConfig.webhook.secret = short
      const res = makeRes()
      const next = jest.fn()
      // Even the *correct* secret is refused — the floor is about the value,
      // not about whether the caller knows it.
      authenticate(makeReq(short), res, next)
      expect(next).not.toHaveBeenCalled()
      expect(res.status).toHaveBeenCalledWith(503)
      expect(res.end).toHaveBeenCalledWith("Webhook secret not configured")
    } finally {
      IbexConfig.webhook.secret = configuredSecret
    }
  })

  it("names the length floor, not just placeholders, when it refuses", () => {
    const { IbexConfig } = jest.requireMock("@config")
    const { baseLogger } = jest.requireMock("@services/logger")
    const configuredSecret = IbexConfig.webhook.secret
    try {
      IbexConfig.webhook.secret = "a".repeat(MIN_SECRET_LENGTH - 1)
      authenticate(makeReq("whatever"), makeRes(), jest.fn())
      const logged = String(baseLogger.error.mock.calls.at(-1)?.[0])
      // An operator who rotated to a short random value greps the log for why:
      // a message that only says "placeholder" sends them looking for one they
      // do not have.
      expect(logged).toContain(String(MIN_SECRET_LENGTH))
    } finally {
      IbexConfig.webhook.secret = configuredSecret
    }
  })

  describe("warnIfIbexWebhookSecretWeak (boot signal)", () => {
    // Without this, a short or placeholder secret 503s every /receive/* call —
    // settled invoices and on-chain receives stop crediting balances — while
    // /health still answers 200 and the boot log says nothing.
    it("warns at boot for unset, short, and placeholder secrets", () => {
      const { IbexConfig } = jest.requireMock("@config")
      const { baseLogger } = jest.requireMock("@services/logger")
      const configuredSecret = IbexConfig.webhook.secret
      try {
        for (const weak of [
          undefined,
          "",
          "not-so-secret",
          "a".repeat(MIN_SECRET_LENGTH - 1),
        ]) {
          baseLogger.warn.mockClear()
          IbexConfig.webhook.secret = weak
          warnIfIbexWebhookSecretWeak()
          expect(baseLogger.warn).toHaveBeenCalledTimes(1)
          expect(String(baseLogger.warn.mock.calls[0][0])).toContain("503")
        }
      } finally {
        IbexConfig.webhook.secret = configuredSecret
      }
    })

    it("stays silent for a usable secret", () => {
      const { baseLogger } = jest.requireMock("@services/logger")
      baseLogger.warn.mockClear()
      warnIfIbexWebhookSecretWeak()
      expect(baseLogger.warn).not.toHaveBeenCalled()
    })
  })

  it("fails closed with 503 when the configured secret is a known-public placeholder", () => {
    // "not-so-secret" ships in this public repo's dev configs — a deployment
    // that forgot to override it would otherwise authenticate ANYONE, and the
    // matching request body would be accepted.
    const { IbexConfig } = jest.requireMock("@config")
    const configuredSecret = IbexConfig.webhook.secret

    try {
      for (const weak of ["not-so-secret", "also-not-so-secret", "change-me"]) {
        IbexConfig.webhook.secret = weak

        const res = makeRes()
        const next = jest.fn()

        authenticate(makeReq(weak), res, next)

        expect(next).not.toHaveBeenCalled()
        expect(res.status).toHaveBeenCalledWith(503)
        expect(res.end).toHaveBeenCalledWith("Webhook secret not configured")
      }
    } finally {
      IbexConfig.webhook.secret = configuredSecret
    }
  })
})
