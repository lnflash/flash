// A strong fixture: the weak-secret guard now also refuses anything under 32
// chars, so a short placeholder here would 503 before the comparison runs.
jest.mock("@config", () => ({
  IbexConfig: {
    webhook: { secret: "Kramerica-Industries-32-chars-plus", previousSecrets: [] },
  },
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
  ibexWebhookAcceptedSecrets,
  warnIfIbexWebhookRotationSecretsUnusable,
} from "@services/ibex/webhook-server/middleware/authenticate"
import { MIN_SECRET_LENGTH } from "@utils/weak-secrets"

import {
  clearDevUnsafeModeFlags,
  restoreDevUnsafeModeFlags,
} from "test/flash/helpers/dev-context-env"

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

  // IBEX binds the webhook secret PER OBJECT at creation time, and two of those
  // objects outlive any rotation: a wallet's lnurlp is created once at wallet
  // creation and stored on the wallet forever, and a handed-out on-chain
  // deposit address stays valid indefinitely. Rotating `secret` alone leaves
  // every pre-existing Lightning address delivering with the OLD value — 401,
  // and settled payments silently stop crediting balances.
  describe("rotation window (previousSecrets)", () => {
    const OUTGOING = "Kramerica-Industries-outgoing-secret"

    const withConfig = (
      config: { secret?: string; previousSecrets?: (string | undefined)[] },
      run: () => void,
    ) => {
      const { IbexConfig } = jest.requireMock("@config")
      const saved = { ...IbexConfig.webhook }
      try {
        Object.assign(IbexConfig.webhook, config)
        run()
      } finally {
        Object.assign(IbexConfig.webhook, saved)
      }
    }

    it("accepts a webhook still signed with the previous secret", () => {
      withConfig({ previousSecrets: [OUTGOING] }, () => {
        const res = makeRes()
        const next = jest.fn()

        authenticate(makeReq(OUTGOING), res, next)

        expect(next).toHaveBeenCalledTimes(1)
        expect(res.status).not.toHaveBeenCalled()
      })
    })

    it("still accepts the current secret while a window is open", () => {
      withConfig({ previousSecrets: [OUTGOING] }, () => {
        const res = makeRes()
        const next = jest.fn()

        authenticate(makeReq("Kramerica-Industries-32-chars-plus"), res, next)

        expect(next).toHaveBeenCalledTimes(1)
      })
    })

    it("rejects a value that is in neither list", () => {
      withConfig({ previousSecrets: [OUTGOING] }, () => {
        const res = makeRes()
        const next = jest.fn()

        authenticate(makeReq(`${OUTGOING}X`), res, next)

        expect(next).not.toHaveBeenCalled()
        expect(res.status).toHaveBeenCalledWith(401)
      })
    })

    // A publicly known value in the rotation list is a forged-webhook path —
    // the thing this middleware exists to close — so weak entries are dropped,
    // not accepted.
    it("never accepts a weak rotation entry", () => {
      withConfig({ previousSecrets: ["not-so-secret", ""] }, () => {
        expect(ibexWebhookAcceptedSecrets()).toEqual([
          "Kramerica-Industries-32-chars-plus",
        ])

        for (const weak of ["not-so-secret", ""]) {
          const res = makeRes()
          const next = jest.fn()

          authenticate(makeReq(weak), res, next)

          expect(next).not.toHaveBeenCalled()
          expect(res.status).toHaveBeenCalledWith(401)
        }
      })
    })

    it("tolerates a config with no previousSecrets key at all", () => {
      withConfig({ previousSecrets: undefined }, () => {
        expect(ibexWebhookAcceptedSecrets()).toEqual([
          "Kramerica-Industries-32-chars-plus",
        ])
      })
    })

    describe("warnIfIbexWebhookRotationSecretsUnusable (boot signal)", () => {
      it("names the entries it will not accept", () => {
        const { baseLogger } = jest.requireMock("@services/logger")
        withConfig({ previousSecrets: ["not-so-secret", OUTGOING] }, () => {
          baseLogger.warn.mockClear()
          warnIfIbexWebhookRotationSecretsUnusable()
          expect(baseLogger.warn).toHaveBeenCalledTimes(1)
          expect(String(baseLogger.warn.mock.calls[0][0])).toContain("401")
        })
      })

      it("stays silent when every entry is usable", () => {
        const { baseLogger } = jest.requireMock("@services/logger")
        withConfig({ previousSecrets: [OUTGOING] }, () => {
          baseLogger.warn.mockClear()
          warnIfIbexWebhookRotationSecretsUnusable()
          expect(baseLogger.warn).not.toHaveBeenCalled()
        })
      })
    })
  })

  it("fails closed with 503 when the configured secret is a known-public placeholder", () => {
    // "not-so-secret" ships in this public repo's dev configs — a deployment
    // that forgot to override it would otherwise authenticate ANYONE, and the
    // matching request body would be accepted. These are all under the length
    // floor, so the floor is what refuses them.
    const { IbexConfig } = jest.requireMock("@config")
    const configuredSecret = IbexConfig.webhook.secret

    try {
      for (const weak of ["not-so-secret", "also-not-so-secret", "change-me"]) {
        expect(weak.length).toBeLessThan(MIN_SECRET_LENGTH)
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

  // The case a length floor cannot catch: the value committed to
  // dev/config/base-config.yaml is 64 random-looking hex chars, and it is
  // published in this repo. A deployment that ships the repo default
  // authenticates anyone who has read it.
  it("fails closed with 503 on the committed dev-only secret outside a dev context", () => {
    const { IbexConfig } = jest.requireMock("@config")
    const configuredSecret = IbexConfig.webhook.secret
    const savedNetwork = process.env.NETWORK
    const committed = "7189c07e9a60977492c9471a527b0d9040c1fa3c5b7bfd7e87e58db018160ddb"

    try {
      expect(committed.length).toBeGreaterThanOrEqual(MIN_SECRET_LENGTH)
      process.env.NETWORK = "mainnet"
      clearDevUnsafeModeFlags()
      IbexConfig.webhook.secret = committed

      const res = makeRes()
      const next = jest.fn()

      authenticate(makeReq(committed), res, next)

      expect(next).not.toHaveBeenCalled()
      expect(res.status).toHaveBeenCalledWith(503)
    } finally {
      IbexConfig.webhook.secret = configuredSecret
      if (savedNetwork === undefined) delete process.env.NETWORK
      else process.env.NETWORK = savedNetwork
      restoreDevUnsafeModeFlags()
    }
  })
})
