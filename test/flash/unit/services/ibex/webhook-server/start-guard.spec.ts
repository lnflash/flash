// The webhook server's boot guard. A weak secret here 503s every /receive/*
// delivery — settled invoices and on-chain receives stop crediting balances —
// while /health keeps answering 200, so a log line is not enough: the rollout
// has to fail.
jest.mock("@config", () => ({
  IbexConfig: {
    webhook: {
      uri: "https://webhooks.example.com",
      port: 4008,
      secret: "Kramerica-Industries-32-chars-plus",
      previousSecrets: [],
    },
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
// The routers pull in the whole ibex service (mongoose, redis, the client);
// none of it is reachable on the path under test.
jest.mock("@services/ibex/webhook-server/routes", () => ({
  onReceive: { router: "on-receive-router" },
  onPay: { router: "on-pay-router" },
  cryptoReceive: { router: "crypto-receive-router" },
}))
jest.mock("express", () => {
  const app = {
    set: jest.fn(),
    use: jest.fn(),
    get: jest.fn(),
    listen: jest.fn(),
  }
  const express = Object.assign(
    jest.fn(() => app),
    { json: jest.fn(() => "json-middleware") },
  )
  return { __esModule: true, default: express, app }
})

import WebhookServer from "@services/ibex/webhook-server"
import { MIN_SECRET_LENGTH, WeakSecretError } from "@utils/weak-secrets"

import {
  clearDevUnsafeModeFlags,
  restoreDevUnsafeModeFlags,
} from "test/flash/helpers/dev-context-env"

const app = jest.requireMock("express").app as { listen: jest.Mock }
const { IbexConfig } = jest.requireMock("@config")
const { baseLogger } = jest.requireMock("@services/logger")

const STRONG = "Kramerica-Industries-32-chars-plus"

describe("ibex webhook server start()", () => {
  const savedWebhook = { ...IbexConfig.webhook }
  const savedNetwork = process.env.NETWORK

  beforeEach(() => {
    jest.clearAllMocks()
    Object.assign(IbexConfig.webhook, savedWebhook)
    process.env.NETWORK = "mainnet"
    clearDevUnsafeModeFlags()
  })

  afterEach(() => {
    Object.assign(IbexConfig.webhook, savedWebhook)
    if (savedNetwork === undefined) delete process.env.NETWORK
    else process.env.NETWORK = savedNetwork
    restoreDevUnsafeModeFlags()
  })

  it("listens with a usable secret", () => {
    WebhookServer.start()

    expect(app.listen).toHaveBeenCalledTimes(1)
    expect(app.listen.mock.calls[0][0]).toBe(4008)
  })

  // Unset / short / known-public: each one would otherwise boot green and drop
  // every credit.
  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["a short placeholder", "not-so-secret"],
    ["under the length floor", "a".repeat(MIN_SECRET_LENGTH - 1)],
    // No length floor catches this one: 64 random-looking hex chars, published
    // in dev/config/base-config.yaml.
    [
      "the committed dev-only value",
      "7189c07e9a60977492c9471a527b0d9040c1fa3c5b7bfd7e87e58db018160ddb",
    ],
  ])("refuses to start when the secret is %s", (_label, secret) => {
    IbexConfig.webhook.secret = secret

    expect(() => WebhookServer.start()).toThrow(WeakSecretError)
    // Nothing binds a port on the refusal path — the entrypoint's
    // exitOnBootFailure turns this into a crash-looping pod, which is visible,
    // instead of a healthy pod silently 503ing every delivery.
    expect(app.listen).not.toHaveBeenCalled()
  })

  it("names the config key it refused", () => {
    IbexConfig.webhook.secret = "x"

    expect(() => WebhookServer.start()).toThrow(/ibex\.webhook\.secret/)
  })

  // A rotation entry that will never authenticate anything is not fatal — the
  // list is optional — but it silently narrows the window it was added to
  // widen, so it has to be visible at boot rather than as 401s hours later.
  it("warns about unusable rotation entries but still starts", () => {
    IbexConfig.webhook.previousSecrets = ["not-so-secret"]

    WebhookServer.start()

    expect(app.listen).toHaveBeenCalledTimes(1)
    expect(baseLogger.warn).toHaveBeenCalledTimes(1)
    expect(String(baseLogger.warn.mock.calls[0][0])).toContain("previousSecrets")
  })

  it("stays quiet when the rotation list is usable", () => {
    IbexConfig.webhook.previousSecrets = [`${STRONG}-previous`]

    WebhookServer.start()

    expect(baseLogger.warn).not.toHaveBeenCalled()
  })
})
