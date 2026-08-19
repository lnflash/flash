const mockFygaroConfig = {
  enabled: true,
  webhook: { port: 4010, secrets: { default: "s3cret" }, timestampSkewMs: 300000 },
  // Mutated per test: `credit.enabled` is what decides whether any push is
  // reachable from this server at all, so it decides whether a missing Firebase
  // credential is an incident or a non-event.
  credit: { enabled: true },
}

// `messaging` is a module-level binding in firebase.ts — null when
// GOOGLE_APPLICATION_CREDENTIALS is unset or the credential fails to load.
// Exposed through a getter so each test picks its value before boot runs; a
// named import is read as a property of the module object at each use site, so
// the getter fires inside startFygaroWebhookServer, not at import time.
let mockMessaging: unknown = {}
const mockAlertBridge = jest.fn()

const mockApp = {
  set: jest.fn(),
  use: jest.fn(),
  get: jest.fn(),
  post: jest.fn(),
  listen: jest.fn(),
}

jest.mock("@config", () => ({
  get FygaroConfig() {
    return mockFygaroConfig
  },
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock("@services/notifications/firebase", () => ({
  get messaging() {
    return mockMessaging
  },
}))

jest.mock("@services/alerts", () => ({
  alertBridge: (...args: unknown[]) => mockAlertBridge(...args),
  // The real key generator, so the static-vs-per-transaction choice this alert
  // depends on is pinned rather than stubbed to a constant.
  generateDedupKey: jest.requireActual("@services/alerts/dedup-key").generateDedupKey,
}))

// The route and middleware are wired, not exercised, by this spec — stubbing
// them keeps the boot path off the Mongo/Kratos/ERPNext import graph.
jest.mock("@services/fygaro/webhook-server/routes/payment", () => ({
  paymentHandler: jest.fn(),
}))
jest.mock("@services/fygaro/webhook-server/middleware/verify-signature", () => ({
  verifyFygaroSignature: jest.fn(),
}))
jest.mock("@services/fygaro/webhook-server/middleware/enabled-guard", () => ({
  fygaroEnabledGuard: jest.fn(),
}))

jest.mock("express", () => {
  const express = jest.fn(() => mockApp)
  ;(express as unknown as { json: unknown }).json = jest.fn(() => "json-middleware")
  return { __esModule: true, default: express }
})

jest.mock("express-rate-limit", () => ({
  __esModule: true,
  default: jest.fn(() => "rate-limit-middleware"),
}))

import { startFygaroWebhookServer } from "@services/fygaro/webhook-server"

beforeEach(() => {
  jest.clearAllMocks()
  mockMessaging = {}
  mockFygaroConfig.credit.enabled = true
})

describe("startFygaroWebhookServer", () => {
  it("pages when credit is ON and Firebase messaging is unavailable — otherwise every push is a silent no-op", () => {
    // firebase.ts leaves `messaging` null when the credential is missing, and
    // push-notifications.ts then returns `true` anyway (its own "FIXME: should
    // return an error?"). Every layer above — including the best-effort wrapper
    // on the money path — reads that as a delivered push, so a regressed secret
    // mount in a chart bump would kill this whole feature for a release with no
    // signal but one boot-time warn nobody watches.
    mockMessaging = null

    startFygaroWebhookServer()

    expect(mockAlertBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "fygaro-webhook",
        severity: "critical",
        // Static: one broken deployment is one incident, not one per webhook.
        dedupKey: "fygaro:push-unavailable",
      }),
    )
  })

  it("stays quiet when Firebase messaging loaded", () => {
    startFygaroWebhookServer()

    expect(mockAlertBridge).not.toHaveBeenCalled()
  })

  it("stays quiet with no messaging when credit is disabled — nothing could push anyway", () => {
    // `fygaro.credit.enabled` defaults to false and is the first rollout state.
    // With it off the gate answers `credit-disabled`, which
    // REFUSAL_NOTIFIES_CUSTOMER keeps deliberately silent, and the credit path
    // is never entered — so no push is reachable and a missing credential
    // breaks nothing. Paging here would mean a CRITICAL on every pod restart
    // and rolling deploy, with no auto-resolve, about a feature switched off by
    // design.
    mockFygaroConfig.credit.enabled = false
    mockMessaging = null

    startFygaroWebhookServer()

    expect(mockAlertBridge).not.toHaveBeenCalled()
  })

  it("still serves /payment when messaging is unavailable", () => {
    // The alert is a signal, not a refusal: the payments themselves must keep
    // being recorded and credited even when nobody can be notified about them.
    mockMessaging = null

    startFygaroWebhookServer()

    expect(mockApp.post).toHaveBeenCalledWith(
      "/payment",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    )
    expect(mockApp.listen).toHaveBeenCalledWith(4010, expect.any(Function))
  })
})
