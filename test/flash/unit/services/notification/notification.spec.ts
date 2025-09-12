import { notificationService, NotificationMethod } from "@services/notification"
import twilio from "twilio"
import { baseLogger } from "@services/logger"

jest.mock("twilio")
jest.mock("@services/logger")

// Mock fetch for email tests
global.fetch = jest.fn()

describe("NotificationService", () => {
  let twilioClientMock: any
  const originalEnv = process.env

  beforeEach(() => {
    jest.clearAllMocks()

    // Mock Twilio client
    twilioClientMock = {
      messages: {
        create: jest.fn().mockResolvedValue({ sid: "test-message-id" }),
      },
    }
    ;(twilio as unknown as jest.Mock).mockReturnValue(twilioClientMock)

    // Mock fetch for SendGrid API
    ;(global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      text: jest.fn().mockResolvedValue("Success"),
    })

    // Reset environment variables
    process.env = { ...originalEnv }
    process.env.TWILIO_SENDGRID_API_KEY = "test-sendgrid-key"
    process.env.TWILIO_SENDGRID_FROM_EMAIL = "test@example.com"
    process.env.TWILIO_FROM = "+1234567890"
    process.env.TWILIO_WHATSAPP_FROM = "+19876543210"
    process.env.TWILIO_ACCOUNT_SID = "test-account-sid"
    process.env.TWILIO_AUTH_TOKEN = "test-auth-token"
  })

  afterEach(() => {
    process.env = originalEnv
  })

  describe("sendNotification - Email via Twilio SendGrid", () => {
    it("should send email successfully via Twilio SendGrid API", async () => {
      const result = await notificationService.sendNotification(
        NotificationMethod.EMAIL,
        "user@example.com",
        "Test Subject",
        "<p>Test HTML Body</p>",
      )

      expect(result).toBe(true)
      expect(global.fetch).toHaveBeenCalledWith(
        "https://api.sendgrid.com/v3/mail/send",
        expect.objectContaining({
          method: "POST",
          headers: {
            "Authorization": "Bearer test-sendgrid-key",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: "user@example.com" }] }],
            from: { email: "test@example.com" },
            subject: "Test Subject",
            content: [
              { type: "text/plain", value: "Test Subject" },
              { type: "text/html", value: "<p>Test HTML Body</p>" },
            ],
          }),
        }),
      )
    })

    it("should handle email send failure", async () => {
      ;(global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status: 400,
        text: jest.fn().mockResolvedValue("Bad request"),
      })

      const result = await notificationService.sendNotification(
        NotificationMethod.EMAIL,
        "user@example.com",
        "Test Subject",
      )

      expect(result).toBe(false)
      expect(baseLogger.error).toHaveBeenCalled()
    })

    it("should use default from email if not configured", async () => {
      delete process.env.TWILIO_SENDGRID_FROM_EMAIL

      await notificationService.sendNotification(
        NotificationMethod.EMAIL,
        "user@example.com",
        "Test Subject",
      )

      expect(global.fetch).toHaveBeenCalledWith(
        "https://api.sendgrid.com/v3/mail/send",
        expect.objectContaining({
          body: expect.stringContaining('"email":"noreply@getflash.io"'),
        }),
      )
    })

    it("should return false if SendGrid API key not configured", async () => {
      delete process.env.TWILIO_SENDGRID_API_KEY

      const result = await notificationService.sendNotification(
        NotificationMethod.EMAIL,
        "user@example.com",
        "Test Subject",
      )

      expect(result).toBe(false)
      expect(baseLogger.error).toHaveBeenCalledWith(
        "TWILIO_SENDGRID_API_KEY not configured",
      )
    })
  })

  describe("sendNotification - SMS via Twilio", () => {
    it("should send SMS successfully", async () => {
      const result = await notificationService.sendNotification(
        NotificationMethod.SMS,
        "+1234567890",
        "Test SMS message",
      )

      expect(result).toBe(true)
      expect(twilioClientMock.messages.create).toHaveBeenCalledWith({
        body: "Test SMS message",
        from: "+1234567890",
        to: "+1234567890",
      })
    })

    it("should handle SMS send failure", async () => {
      twilioClientMock.messages.create.mockRejectedValue(new Error("Twilio error"))

      const result = await notificationService.sendNotification(
        NotificationMethod.SMS,
        "+1234567890",
        "Test SMS message",
      )

      expect(result).toBe(false)
      expect(baseLogger.error).toHaveBeenCalled()
    })

    it("should return false if Twilio FROM not configured", async () => {
      delete process.env.TWILIO_FROM

      const result = await notificationService.sendNotification(
        NotificationMethod.SMS,
        "+1234567890",
        "Test SMS message",
      )

      expect(result).toBe(false)
      expect(baseLogger.error).toHaveBeenCalledWith("TWILIO_FROM not configured")
    })
  })

  describe("sendNotification - WhatsApp via Twilio", () => {
    it("should send WhatsApp message successfully", async () => {
      const result = await notificationService.sendNotification(
        NotificationMethod.WHATSAPP,
        "+1234567890",
        "Test WhatsApp message",
      )

      expect(result).toBe(true)
      expect(twilioClientMock.messages.create).toHaveBeenCalledWith({
        body: "Test WhatsApp message",
        from: "whatsapp:+19876543210",
        to: "whatsapp:+1234567890",
      })
    })

    it("should handle number already prefixed with whatsapp:", async () => {
      const result = await notificationService.sendNotification(
        NotificationMethod.WHATSAPP,
        "whatsapp:+1234567890",
        "Test WhatsApp message",
      )

      expect(result).toBe(true)
      expect(twilioClientMock.messages.create).toHaveBeenCalledWith({
        body: "Test WhatsApp message",
        from: "whatsapp:+19876543210",
        to: "whatsapp:+1234567890",
      })
    })

    it("should handle WhatsApp from number already prefixed", async () => {
      process.env.TWILIO_WHATSAPP_FROM = "whatsapp:+19876543210"

      const result = await notificationService.sendNotification(
        NotificationMethod.WHATSAPP,
        "+1234567890",
        "Test WhatsApp message",
      )

      expect(result).toBe(true)
      expect(twilioClientMock.messages.create).toHaveBeenCalledWith({
        body: "Test WhatsApp message",
        from: "whatsapp:+19876543210",
        to: "whatsapp:+1234567890",
      })
    })

    it("should return false if WhatsApp from not configured", async () => {
      delete process.env.TWILIO_WHATSAPP_FROM

      const result = await notificationService.sendNotification(
        NotificationMethod.WHATSAPP,
        "+1234567890",
        "Test WhatsApp message",
      )

      expect(result).toBe(false)
      expect(baseLogger.error).toHaveBeenCalledWith("TWILIO_WHATSAPP_FROM not configured")
    })

    it("should handle WhatsApp send failure", async () => {
      twilioClientMock.messages.create.mockRejectedValue(new Error("WhatsApp error"))

      const result = await notificationService.sendNotification(
        NotificationMethod.WHATSAPP,
        "+1234567890",
        "Test WhatsApp message",
      )

      expect(result).toBe(false)
      expect(baseLogger.error).toHaveBeenCalled()
    })
  })

  describe("Unified Twilio integration", () => {
    it("should use single Twilio client for all channels", () => {
      expect(twilio).toHaveBeenCalledTimes(1)
      expect(twilio).toHaveBeenCalledWith("test-account-sid", "test-auth-token")
    })

    it("should handle unknown notification method", async () => {
      const result = await notificationService.sendNotification(
        "UNKNOWN" as NotificationMethod,
        "test@example.com",
        "Test message",
      )

      expect(result).toBe(false)
      expect(baseLogger.error).toHaveBeenCalledWith(
        { method: "UNKNOWN" },
        "Unknown notification method",
      )
    })
  })
})
