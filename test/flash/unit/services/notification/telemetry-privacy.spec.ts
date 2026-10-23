import type { NotificationMethod as NotificationMethodType } from "@services/notification"

jest.mock("twilio", () => jest.fn())
jest.mock("@sendgrid/mail", () => ({ setApiKey: jest.fn(), send: jest.fn() }))
jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

const privateValues = {
  accountSid: "PRIVATE_TWILIO_ACCOUNT_SID",
  authToken: "PRIVATE_TWILIO_AUTH_TOKEN",
  verifyServiceId: "PRIVATE_VERIFY_SERVICE_ID",
  apiKey: "PRIVATE_SENDGRID_KEY",
  recipient: "+18765550123",
  email: "PRIVATE_EMAIL@example.test",
  sender: "+18765550999",
  subject: "PRIVATE_BANK_CUSTOMER",
  body: "PRIVATE_ONE_TIME_INVITE_LINK",
  html: "<p>PRIVATE_BANK_ACCOUNT</p>",
  error: "PRIVATE_PROVIDER_ERROR_BODY",
  messageID: "PRIVATE_PROVIDER_MESSAGE_ID",
  bridgeSecret: "PRIVATE_BRIDGE_SECRET",
  template: "PRIVATE_TEMPLATE_ID",
  templateName: "PRIVATE_TEMPLATE_NAME",
}

const providerError = () =>
  Object.assign(new Error(privateValues.error), {
    code: privateValues.authToken,
    status: privateValues.accountSid,
    moreInfo: privateValues.body,
    details: privateValues.html,
    config: { headers: { authorization: privateValues.apiKey }, data: privateValues },
    response: {
      body: privateValues,
      request: { headers: { authorization: privateValues.authToken } },
    },
  })

const loadNotifier = ({
  twilioFailure = false,
  sendGridFailure = false,
  configured = true,
} = {}) => {
  jest.resetModules()
  jest.doMock("@config", () => ({
    env: configured
      ? {
          TWILIO_ACCOUNT_SID: privateValues.accountSid,
          TWILIO_AUTH_TOKEN: privateValues.authToken,
          TWILIO_VERIFY_SERVICE_ID: privateValues.verifyServiceId,
          TWILIO_FROM: privateValues.sender,
          TWILIO_WHATSAPP_FROM: privateValues.sender,
        }
      : {},
    SendGridConfig: configured ? { apiKey: privateValues.apiKey } : {},
    TWILIO_FROM: configured ? privateValues.sender : undefined,
    TWILIO_WHATSAPP_FROM: configured ? privateValues.sender : undefined,
  }))
  const twilio = jest.requireMock("twilio") as jest.Mock
  const sendGrid = jest.requireMock("@sendgrid/mail") as {
    setApiKey: jest.Mock
    send: jest.Mock
  }
  const logger = jest.requireMock("@services/logger").baseLogger as {
    info: jest.Mock
    warn: jest.Mock
    error: jest.Mock
  }
  const create = jest
    .fn()
    .mockResolvedValue({ sid: privateValues.messageID, status: privateValues.error })
  twilio.mockImplementation(() => {
    if (twilioFailure) throw providerError()
    return { messages: { create } }
  })
  sendGrid.setApiKey.mockImplementation(() => {
    if (sendGridFailure) throw providerError()
  })
  sendGrid.send.mockResolvedValue([{ body: privateValues }])
  const module = jest.requireActual(
    "@services/notification",
  ) as typeof import("@services/notification")
  const assertPrivateTelemetryAbsent = () => {
    const telemetry = JSON.stringify(Object.values(logger).flatMap((fn) => fn.mock.calls))
    for (const value of Object.values(privateValues))
      expect(telemetry).not.toContain(value)
  }
  return { ...module, twilio, sendGrid, create, assertPrivateTelemetryAbsent }
}

describe("notification provider telemetry privacy", () => {
  const originalFetch = global.fetch
  const keys = [
    "WA_BRIDGE_URL",
    "WA_BRIDGE_SECRET",
    "TWILIO_WHATSAPP_TEMPLATE_SID",
    "SENDGRID_FROM_EMAIL",
  ]
  let previous: Array<string | undefined>
  let fetchMock: jest.Mock

  beforeEach(() => {
    previous = keys.map((key) => process.env[key])
    for (const key of keys) delete process.env[key]
    process.env.TWILIO_WHATSAPP_TEMPLATE_SID = privateValues.template
    fetchMock = jest.fn()
    global.fetch = fetchMock as unknown as typeof fetch
  })
  afterEach(() => {
    global.fetch = originalFetch
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key]
      else process.env[key] = previous[index]
    })
  })

  it("preserves SDK credentials and exact email payload without logging recipients or content", async () => {
    const {
      notificationService,
      NotificationMethod,
      twilio,
      sendGrid,
      assertPrivateTelemetryAbsent,
    } = loadNotifier()
    expect(twilio).toHaveBeenCalledWith(privateValues.accountSid, privateValues.authToken)
    expect(sendGrid.setApiKey).toHaveBeenCalledWith(privateValues.apiKey)
    expect(
      await notificationService.sendNotification(
        NotificationMethod.EMAIL,
        privateValues.email,
        privateValues.subject,
        privateValues.html,
      ),
    ).toBe(true)
    expect(sendGrid.send).toHaveBeenCalledWith({
      to: privateValues.email,
      from: "noreply@getflash.io",
      subject: privateValues.subject,
      text: privateValues.subject,
      html: privateValues.html,
    })
    assertPrivateTelemetryAbsent()
  })

  it("preserves exact SMS payload and successful delivery", async () => {
    const {
      notificationService,
      NotificationMethod,
      create,
      assertPrivateTelemetryAbsent,
    } = loadNotifier()
    expect(
      await notificationService.sendNotification(
        NotificationMethod.SMS,
        privateValues.recipient,
        privateValues.body,
      ),
    ).toBe(true)
    expect(create).toHaveBeenCalledWith({
      body: privateValues.body,
      from: privateValues.sender,
      to: privateValues.recipient,
    })
    assertPrivateTelemetryAbsent()
  })

  it.each([false, true])(
    "preserves WhatsApp payload, prefix and template selection (template=%s)",
    async (template) => {
      const {
        notificationService,
        NotificationMethod,
        create,
        assertPrivateTelemetryAbsent,
      } = loadNotifier()
      const body = template
        ? JSON.stringify({
            templateName: privateValues.templateName,
            templateVariables: { "1": privateValues.body },
          })
        : privateValues.body
      expect(
        await notificationService.sendNotification(
          NotificationMethod.WHATSAPP,
          privateValues.recipient,
          body,
        ),
      ).toBe(true)
      expect(create).toHaveBeenCalledWith(
        template
          ? {
              from: `whatsapp:${privateValues.sender}`,
              to: `whatsapp:${privateValues.recipient}`,
              contentSid: privateValues.template,
              contentVariables: JSON.stringify({ "1": privateValues.body }),
            }
          : {
              from: `whatsapp:${privateValues.sender}`,
              to: `whatsapp:${privateValues.recipient}`,
              body: privateValues.body,
            },
      )
      assertPrivateTelemetryAbsent()
    },
  )

  it.each(["EMAIL", "SMS", "WHATSAPP"])(
    "keeps %s SDK failures false without serializing private SDK errors",
    async (method) => {
      const {
        notificationService,
        NotificationMethod,
        create,
        sendGrid,
        assertPrivateTelemetryAbsent,
      } = loadNotifier()
      create.mockRejectedValue(providerError())
      sendGrid.send.mockRejectedValue(providerError())
      expect(
        await notificationService.sendNotification(
          NotificationMethod[method as keyof typeof NotificationMethod],
          privateValues.recipient,
          privateValues.body,
        ),
      ).toBe(false)
      assertPrivateTelemetryAbsent()
    },
  )

  it("contains raw initialization failures while preserving unavailable delivery decisions", async () => {
    const {
      notificationService,
      NotificationMethod,
      create,
      assertPrivateTelemetryAbsent,
    } = loadNotifier({ twilioFailure: true, sendGridFailure: true })
    expect(
      await notificationService.sendNotification(
        NotificationMethod.SMS,
        privateValues.recipient,
        privateValues.body,
      ),
    ).toBe(false)
    expect(
      await notificationService.sendNotification(
        NotificationMethod.WHATSAPP,
        privateValues.recipient,
        privateValues.body,
      ),
    ).toBe(false)
    expect(create).not.toHaveBeenCalled()
    assertPrivateTelemetryAbsent()
  })

  it("preserves unconfigured refusal and unknown-method behavior without logging caller text", async () => {
    const {
      notificationService,
      NotificationMethod,
      create,
      sendGrid,
      assertPrivateTelemetryAbsent,
    } = loadNotifier({ configured: false })
    for (const method of Object.values(NotificationMethod))
      expect(
        await notificationService.sendNotification(
          method,
          privateValues.recipient,
          privateValues.body,
        ),
      ).toBe(false)
    expect(
      await notificationService.sendNotification(
        privateValues.authToken as NotificationMethodType,
        privateValues.email,
        privateValues.body,
      ),
    ).toBe(false)
    expect(create).not.toHaveBeenCalled()
    expect(sendGrid.send).not.toHaveBeenCalled()
    assertPrivateTelemetryAbsent()
  })

  it("keeps exact bridge auth/body and handles successful provider data without logging it", async () => {
    const {
      notificationService,
      NotificationMethod,
      create,
      assertPrivateTelemetryAbsent,
    } = loadNotifier()
    process.env.WA_BRIDGE_URL = "https://bridge.example.test/send"
    process.env.WA_BRIDGE_SECRET = privateValues.bridgeSecret
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, ...privateValues }),
    })
    expect(
      await notificationService.sendNotification(
        NotificationMethod.WHATSAPP,
        privateValues.recipient,
        privateValues.body,
      ),
    ).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      "https://bridge.example.test/send",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Send-Token": privateValues.bridgeSecret,
        },
        body: JSON.stringify({ to: privateValues.recipient, text: privateValues.body }),
        signal: expect.any(AbortSignal),
      }),
    )
    expect(create).not.toHaveBeenCalled()
    assertPrivateTelemetryAbsent()
  })

  it.each(["rejected", "not-ok", "malformed-json"])(
    "keeps bridge %s failure false and private",
    async (failure) => {
      const { notificationService, NotificationMethod, assertPrivateTelemetryAbsent } =
        loadNotifier()
      process.env.WA_BRIDGE_URL = "https://bridge.example.test/send"
      process.env.WA_BRIDGE_SECRET = privateValues.bridgeSecret
      if (failure === "rejected") fetchMock.mockRejectedValue(providerError())
      else
        fetchMock.mockResolvedValue({
          ok: false,
          status: privateValues.authToken,
          json:
            failure === "malformed-json"
              ? async () => {
                  throw providerError()
                }
              : async () => ({ ok: false, ...privateValues }),
        })
      expect(
        await notificationService.sendNotification(
          NotificationMethod.WHATSAPP,
          privateValues.recipient,
          privateValues.body,
        ),
      ).toBe(false)
      assertPrivateTelemetryAbsent()
    },
  )
})
