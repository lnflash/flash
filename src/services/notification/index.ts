import twilio from "twilio"
import sgMail from "@sendgrid/mail"
import { baseLogger } from "@services/logger"
import { env, SendGridConfig, TWILIO_FROM, TWILIO_WHATSAPP_FROM } from "@config"

// Single source of truth for whether WhatsApp delivery routes through the
// Baileys wa-bridge (authed POST /send) instead of Twilio. Both the transport
// (sendWhatsApp) and the invite message-body selection (sendInviteNotification)
// read this, so the two decisions can never disagree. Returns null when the
// bridge is not configured; warns if exactly one of the two vars is set — a
// misconfiguration that would otherwise silently fall back to the Twilio path.
export const waBridgeConfig = (): { url: string; secret: string } | null => {
  const url = process.env.WA_BRIDGE_URL
  const secret = process.env.WA_BRIDGE_SECRET
  if (url && secret) return { url, secret }
  if (url || secret) {
    baseLogger.warn(
      "WA_BRIDGE_URL and WA_BRIDGE_SECRET must both be set to route WhatsApp via the wa-bridge; falling back to Twilio",
    )
  }
  return null
}

export enum NotificationMethod {
  EMAIL = "EMAIL",
  SMS = "SMS",
  WHATSAPP = "WHATSAPP",
}

export interface NotificationService {
  sendNotification(
    method: NotificationMethod,
    to: string,
    subjectOrBody: string,
    htmlBody?: string,
  ): Promise<boolean>
}

class NotificationServiceImpl implements NotificationService {
  private twilioClient: twilio.Twilio | null = null

  constructor() {
    this.initializeTwilio()
    this.initializeSendGrid()
  }

  private initializeTwilio() {
    try {
      if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) {
        baseLogger.info(
          { operation: "initialize_twilio", outcome: "started" },
          "Initializing Twilio client",
        )

        this.twilioClient = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN)
        baseLogger.info("Twilio client initialized successfully")
      } else {
        baseLogger.warn(
          { operation: "initialize_twilio", outcome: "unconfigured" },
          "Twilio credentials not fully configured",
        )
      }
    } catch {
      baseLogger.error(
        { operation: "initialize_twilio", outcome: "failed" },
        "Failed to initialize Twilio client",
      )
    }
  }

  private initializeSendGrid() {
    try {
      if (SendGridConfig?.apiKey) {
        sgMail.setApiKey(SendGridConfig.apiKey)
        baseLogger.info("SendGrid client initialized successfully")
      } else {
        baseLogger.warn("SendGrid API key not configured")
      }
    } catch {
      baseLogger.error(
        { operation: "initialize_sendgrid", outcome: "failed" },
        "Failed to initialize SendGrid client",
      )
    }
  }

  async sendNotification(
    method: NotificationMethod,
    to: string,
    subjectOrBody: string,
    htmlBody?: string,
  ): Promise<boolean> {
    try {
      switch (method) {
        case NotificationMethod.EMAIL:
          return await this.sendEmail(to, subjectOrBody, htmlBody)
        case NotificationMethod.SMS:
          return await this.sendSMS(to, subjectOrBody)
        case NotificationMethod.WHATSAPP:
          return await this.sendWhatsApp(to, subjectOrBody)
        default:
          baseLogger.error(
            { operation: "send_notification", outcome: "unsupported_method" },
            "Unknown notification method",
          )
          return false
      }
    } catch {
      baseLogger.error(
        { operation: "send_notification", outcome: "failed" },
        "Failed to send notification",
      )
      return false
    }
  }

  private async sendEmail(
    to: string,
    subject: string,
    htmlBody?: string,
  ): Promise<boolean> {
    if (!SendGridConfig?.apiKey) {
      baseLogger.error("SendGrid API key not configured")
      return false
    }

    const fromEmail = process.env.SENDGRID_FROM_EMAIL || "noreply@getflash.io"

    try {
      await sgMail.send({
        to,
        from: fromEmail,
        subject,
        text: subject,
        html: htmlBody || subject,
      })

      baseLogger.info(
        { operation: "send_email", outcome: "sent" },
        "Email sent successfully via SendGrid",
      )
      return true
    } catch {
      baseLogger.error(
        { operation: "send_email", outcome: "failed" },
        "Failed to send email via SendGrid",
      )
      return false
    }
  }

  private async sendSMS(to: string, body: string): Promise<boolean> {
    if (!this.twilioClient) {
      baseLogger.error("Twilio client not configured")
      return false
    }

    if (!TWILIO_FROM) {
      baseLogger.error("TWILIO_FROM not configured")
      return false
    }

    try {
      await this.twilioClient.messages.create({
        body,
        from: TWILIO_FROM,
        to,
      })
      baseLogger.info(
        { operation: "send_sms", outcome: "sent" },
        "SMS sent successfully via Twilio",
      )
      return true
    } catch {
      baseLogger.error({ operation: "send_sms", outcome: "failed" }, "Failed to send SMS")
      return false
    }
  }

  private async sendWhatsApp(to: string, body: string): Promise<boolean> {
    // When the wa-bridge is configured (see waBridgeConfig), WhatsApp messages
    // go out through its authed POST /send instead of Twilio (no Twilio
    // WhatsApp sender is provisioned in any env today). This gate is env-based,
    // not environment-restricted — it fires wherever both vars are set.
    const bridge = waBridgeConfig()
    if (bridge) {
      return this.sendWhatsAppViaBridge(bridge.url, bridge.secret, to, body)
    }

    if (!this.twilioClient) {
      baseLogger.error("Twilio client not configured")
      return false
    }

    if (!TWILIO_WHATSAPP_FROM) {
      baseLogger.error("TWILIO_WHATSAPP_FROM not configured")
      return false
    }

    const whatsappTo = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`
    const whatsappFrom = TWILIO_WHATSAPP_FROM.startsWith("whatsapp:")
      ? TWILIO_WHATSAPP_FROM
      : `whatsapp:${TWILIO_WHATSAPP_FROM}`

    baseLogger.info(
      { operation: "send_whatsapp", outcome: "started" },
      "Attempting to send WhatsApp message",
    )

    try {
      // Check if body contains template information
      const messageOptions: {
        from: string
        to: string
        body?: string
        contentSid?: string
        contentVariables?: string
      } = {
        from: whatsappFrom,
        to: whatsappTo,
      }

      try {
        const templateData = JSON.parse(body)
        if (templateData.templateName && templateData.templateVariables) {
          // Use WhatsApp template
          messageOptions.contentSid = process.env.TWILIO_WHATSAPP_TEMPLATE_SID || ""
          messageOptions.contentVariables = JSON.stringify(templateData.templateVariables)
        } else {
          // Regular message (for sandbox/testing)
          messageOptions.body = body
        }
      } catch {
        // Not JSON, use as regular message body
        messageOptions.body = body
      }

      // Redacted: body/contentVariables can carry a raw invite token (tokens
      // are stored only as sha256 hashes — they must never reach the logs).
      baseLogger.info(
        {
          operation: "send_whatsapp",
          usesTemplate: Boolean(messageOptions.contentSid),
        },
        "Sending WhatsApp message with options",
      )

      await this.twilioClient.messages.create(messageOptions)

      baseLogger.info(
        { operation: "send_whatsapp", outcome: "sent" },
        "WhatsApp message sent successfully via Twilio",
      )
      return true
    } catch {
      baseLogger.error(
        { operation: "send_whatsapp", outcome: "failed" },
        "Failed to send WhatsApp message",
      )
      return false
    }
  }

  // Deliver a plain-text WhatsApp message through the Baileys wa-bridge
  // (flash-support-infra/services/wa-bridge, authed POST /send). Message
  // content is never logged — invite links carry one-time tokens.
  private async sendWhatsAppViaBridge(
    url: string,
    secret: string,
    to: string,
    body: string,
  ): Promise<boolean> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Send-Token": secret },
        body: JSON.stringify({ to, text: body }),
        signal: controller.signal,
      })
      const payload = (await resp.json().catch(() => ({}))) as { ok?: boolean }
      const ok = resp.ok && payload.ok === true
      if (ok) {
        baseLogger.info(
          { operation: "send_whatsapp_bridge", outcome: "sent" },
          "WhatsApp message sent via wa-bridge",
        )
      } else {
        baseLogger.error(
          { operation: "send_whatsapp_bridge", outcome: "failed" },
          "wa-bridge send failed",
        )
      }
      return ok
    } catch {
      baseLogger.error(
        { operation: "send_whatsapp_bridge", outcome: "failed" },
        "wa-bridge send error",
      )
      return false
    } finally {
      clearTimeout(timeout)
    }
  }
}

export const notificationService = new NotificationServiceImpl()
