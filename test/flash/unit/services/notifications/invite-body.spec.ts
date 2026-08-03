import { InviteMethod } from "@domain/invite"

const mockSendNotification = jest.fn()
jest.mock("@services/notification", () => ({
  NotificationMethod: { EMAIL: "EMAIL", SMS: "SMS", WHATSAPP: "WHATSAPP" },
  notificationService: {
    sendNotification: (...a: unknown[]) => mockSendNotification(...a),
  },
  // Mirror the real gate (env-driven) so this suite drives the body selection
  // via WA_BRIDGE_* exactly as the transport does — one gate, one behavior.
  waBridgeConfig: () => {
    const url = process.env.WA_BRIDGE_URL
    const secret = process.env.WA_BRIDGE_SECRET
    return url && secret ? { url, secret } : null
  },
}))

import { sendInviteNotification } from "@services/notifications/invite"

const TOKEN = "a".repeat(40)

describe("sendInviteNotification WHATSAPP body selection", () => {
  beforeEach(() => {
    mockSendNotification.mockReset()
    mockSendNotification.mockResolvedValue(true)
  })

  afterEach(() => {
    delete process.env.WA_BRIDGE_URL
    delete process.env.WA_BRIDGE_SECRET
  })

  it("uses plain text with the invite link when the wa-bridge is configured", async () => {
    process.env.WA_BRIDGE_URL = "http://bridge.local:3850/send"
    process.env.WA_BRIDGE_SECRET = "sekrit"

    const ok = await sendInviteNotification({
      method: InviteMethod.WHATSAPP,
      contact: "+18765550123",
      token: TOKEN,
      senderName: "dreadlocks",
    })

    expect(ok).toBe(true)
    const body = mockSendNotification.mock.calls[0][2] as string
    expect(body).toContain("dreadlocks invited you to Flash!")
    expect(body).toContain(`token=${TOKEN}`)
    expect(() => JSON.parse(body)).toThrow() // plain text, not a template blob
  })

  it("uses the Twilio template blob when the bridge is not configured", async () => {
    const ok = await sendInviteNotification({
      method: InviteMethod.WHATSAPP,
      contact: "+18765550123",
      token: TOKEN,
      senderName: "dreadlocks",
    })

    expect(ok).toBe(true)
    const body = mockSendNotification.mock.calls[0][2] as string
    const parsed = JSON.parse(body)
    expect(parsed.templateName).toBe("flash_invite")
    expect(parsed.templateVariables["2"]).toBe(TOKEN)
  })
})
