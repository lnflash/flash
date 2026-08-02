import { notificationService, NotificationMethod } from "@services/notification"

// The Twilio client is intentionally unconfigured in this suite (no TWILIO_*
// env), so the non-bridge path deterministically fails — which lets us assert
// the bridge path is what succeeded.

describe("wa-bridge WhatsApp delivery", () => {
  const realFetch = global.fetch
  let fetchMock: jest.Mock

  beforeEach(() => {
    fetchMock = jest.fn()
    global.fetch = fetchMock as unknown as typeof fetch
    process.env.WA_BRIDGE_URL = "http://bridge.local:3850/send"
    process.env.WA_BRIDGE_SECRET = "sekrit"
  })

  afterEach(() => {
    global.fetch = realFetch
    delete process.env.WA_BRIDGE_URL
    delete process.env.WA_BRIDGE_SECRET
  })

  const okResponse = (body: unknown, status = 200) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response

  it("sends via the bridge with the auth header and {to, text} body", async () => {
    fetchMock.mockResolvedValue(okResponse({ ok: true, id: "MSGID" }))

    const result = await notificationService.sendNotification(
      NotificationMethod.WHATSAPP,
      "+18765550123",
      "hello from flash",
    )

    expect(result).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("http://bridge.local:3850/send")
    expect(init.method).toBe("POST")
    expect(init.headers["X-Send-Token"]).toBe("sekrit")
    expect(JSON.parse(init.body)).toEqual({
      to: "+18765550123",
      text: "hello from flash",
    })
  })

  it("returns false when the bridge responds without ok:true", async () => {
    fetchMock.mockResolvedValue(okResponse({ error: "unauthorized" }, 401))
    const result = await notificationService.sendNotification(
      NotificationMethod.WHATSAPP,
      "+18765550123",
      "hello",
    )
    expect(result).toBe(false)
  })

  it("returns false when the bridge call throws (network)", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"))
    const result = await notificationService.sendNotification(
      NotificationMethod.WHATSAPP,
      "+18765550123",
      "hello",
    )
    expect(result).toBe(false)
  })

  it("falls back to the Twilio path (and does not call the bridge) when unconfigured", async () => {
    delete process.env.WA_BRIDGE_URL
    delete process.env.WA_BRIDGE_SECRET
    const result = await notificationService.sendNotification(
      NotificationMethod.WHATSAPP,
      "+18765550123",
      "hello",
    )
    // No Twilio client in this suite -> the fallback path fails, proving the
    // bridge really is the only reason the configured case succeeds.
    expect(result).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
