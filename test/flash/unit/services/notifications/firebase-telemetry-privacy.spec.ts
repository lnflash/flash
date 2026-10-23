jest.mock("@config", () => ({
  GOOGLE_APPLICATION_CREDENTIALS: "fixture-configured-without-reading-credentials",
  getDefaultFCMTopics: () => [],
}))
jest.mock("firebase-admin", () => ({
  initializeApp: jest.fn(),
  credential: { applicationDefault: jest.fn(() => ({})) },
  messaging: jest.fn(),
}))
jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

const privateValues = [
  "FCM_PRIVATE_TOKEN",
  "PRIVATE_TOPIC",
  "PROVIDER_PRIVATE_MESSAGE",
  "PRIVATE_BASIC_PASSWORD",
]
const providerError = (code = "messaging/internal-error") =>
  Object.assign(new Error(privateValues.join(" ")), {
    code,
    token: privateValues[0],
    config: { headers: { authorization: privateValues[3] } },
  })

const loadAdapter = (initializeError?: Error) => {
  jest.resetModules()
  const admin = jest.requireMock("firebase-admin")
  const logger = jest.requireMock("@services/logger").baseLogger
  const messaging = { send: jest.fn(), subscribeToTopic: jest.fn() }
  admin.messaging.mockReturnValue(messaging)
  if (initializeError)
    admin.initializeApp.mockImplementation(() => {
      throw initializeError
    })
  const adapter = jest.requireActual("@services/notifications/firebase")
    .default as typeof import("@services/notifications/firebase").default
  const telemetry = () =>
    JSON.stringify(Object.values(logger).flatMap((fn) => (fn as jest.Mock).mock.calls))
  const assertPrivateTelemetryAbsent = () => {
    for (const value of privateValues) expect(telemetry()).not.toContain(value)
  }
  return { adapter, messaging, logger, telemetry, assertPrivateTelemetryAbsent }
}

describe("Firebase adapter private source boundary", () => {
  it("validates the exact device token in dry-run mode without logging it", async () => {
    const { adapter, messaging, assertPrivateTelemetryAbsent } = loadAdapter()
    messaging.send.mockResolvedValue("provider-message-id")
    expect(await adapter.isDeviceTokenValid(privateValues[0])).toBe(true)
    expect(messaging.send).toHaveBeenCalledWith(
      {
        token: privateValues[0],
        notification: { title: "Test Message", body: "Checking if FCM token is valid" },
      },
      true,
    )
    assertPrivateTelemetryAbsent()
  })

  it("returns false only for the known stale-token response without logging token or error body", async () => {
    const { adapter, messaging, telemetry, assertPrivateTelemetryAbsent } = loadAdapter()
    messaging.send.mockRejectedValue(
      providerError("messaging/registration-token-not-registered"),
    )
    expect(await adapter.isDeviceTokenValid(privateValues[0])).toBe(false)
    expect(telemetry()).toContain("messaging/registration-token-not-registered")
    assertPrivateTelemetryAbsent()
  })

  it.each(["messaging/third-party-auth-error", "PROVIDER_PRIVATE_MESSAGE"])(
    "returns a safe domain failure for %s",
    async (code) => {
      const { adapter, messaging, assertPrivateTelemetryAbsent } = loadAdapter()
      messaging.send.mockRejectedValue(providerError(code))
      const result = await adapter.isDeviceTokenValid(privateValues[0])
      expect(result).toBeInstanceOf(Error)
      const error = result as Error & { failureCode: string }
      expect(error.name).toBe("FirebaseMessageError")
      expect(error.failureCode).toBe(
        code.startsWith("messaging/") ? code : "messaging/unknown-error",
      )
      const serializedError = JSON.stringify({
        ...error,
        message: error.message,
        stack: error.stack,
      })
      for (const value of privateValues) expect(serializedError).not.toContain(value)
      assertPrivateTelemetryAbsent()
    },
  )

  it("keeps provider topic arguments exact and omits topic, tokens and malformed counts from logs", async () => {
    const { adapter, messaging, assertPrivateTelemetryAbsent } = loadAdapter()
    messaging.subscribeToTopic.mockResolvedValue({
      successCount: privateValues[0],
      failureCount: privateValues[2],
      errors: [providerError()],
    })
    await adapter.subscribeToTopics([privateValues[0]], [privateValues[1]])
    expect(messaging.subscribeToTopic).toHaveBeenCalledWith(
      [privateValues[0]],
      privateValues[1],
    )
    assertPrivateTelemetryAbsent()
  })

  it("contains fire-and-forget topic rejections before process-wide rejection logging", async () => {
    const { adapter, messaging, logger, assertPrivateTelemetryAbsent } = loadAdapter()
    messaging.subscribeToTopic.mockRejectedValue(providerError())
    await adapter.subscribeToTopics(privateValues[0], [privateValues[1]])
    expect(messaging.subscribeToTopic).toHaveBeenCalledWith(
      privateValues[0],
      privateValues[1],
    )
    expect(logger.error).toHaveBeenCalledWith(
      { operation: "subscribe_push_topic", code: "messaging/internal-error" },
      "Push topic subscription failed",
    )
    assertPrivateTelemetryAbsent()
  })

  it("does not log initialization error credentials and preserves unavailable behavior", async () => {
    const { adapter, messaging, assertPrivateTelemetryAbsent } =
      loadAdapter(providerError())
    const result = await adapter.isDeviceTokenValid(privateValues[0])
    expect((result as Error).name).toBe("FirebaseNotAvailable")
    expect(messaging.send).not.toHaveBeenCalled()
    assertPrivateTelemetryAbsent()
  })
})
