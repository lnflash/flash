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
        // Never log credential material (not even a prefix/length).
        baseLogger.info(
          {
            accountSid: env.TWILIO_ACCOUNT_SID,
            verifyServiceId: env.TWILIO_VERIFY_SERVICE_ID,
            twilioFrom: env.TWILIO_FROM || "NOT SET",
            twilioWhatsAppFrom: env.TWILIO_WHATSAPP_FROM || "NOT SET",
          },
          "Initializing Twilio client with credentials",
        )

        this.twilioClient = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN)
        baseLogger.info("Twilio client initialized successfully")
      } else {
        baseLogger.warn(
          {
            hasAccountSid: !!env.TWILIO_ACCOUNT_SID,
            hasAuthToken: !!env.TWILIO_AUTH_TOKEN,
          },
          "Twilio credentials not fully configured",
        )
      }
    } catch (error) {
      baseLogger.error({ error }, "Failed to initialize Twilio client")
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
    } catch (error) {
      baseLogger.error({ error }, "Failed to initialize SendGrid client")
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
          baseLogger.error({ method }, "Unknown notification method")
          return false
      }
    } catch (error) {
      baseLogger.error({ error, method, to }, "Failed to send notification")
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

      baseLogger.info({ to }, "Email sent successfully via SendGrid")
      return true
    } catch (error) {
      baseLogger.error({ error, to }, "Failed to send email via SendGrid")
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
      baseLogger.info({ to }, "SMS sent successfully via Twilio")
      return true
    } catch (error) {
      baseLogger.error({ error, to }, "Failed to send SMS")
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
      {
        to: whatsappTo,
        from: whatsappFrom,
        bodyLength: body.length,
        accountSid: env.TWILIO_ACCOUNT_SID,
        hasAuthToken: !!env.TWILIO_AUTH_TOKEN,
      },
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
          from: messageOptions.from,
          to: messageOptions.to,
          usesTemplate: Boolean(messageOptions.contentSid),
        },
        "Sending WhatsApp message with options",
      )

      const message = await this.twilioClient.messages.create(messageOptions)

      baseLogger.info(
        {
          to: whatsappTo,
          messageSid: message.sid,
          status: message.status,
        },
        "WhatsApp message sent successfully via Twilio",
      )
      return true
    } catch (error) {
      const err = error as {
        message?: string
        code?: string
        status?: number
        moreInfo?: string
        details?: string
      }
      baseLogger.error(
        {
          error: {
            message: err.message,
            code: err.code,
            status: err.status,
            moreInfo: err.moreInfo,
            details: err.details,
          },
          to: whatsappTo,
          from: whatsappFrom,
          accountSid: env.TWILIO_ACCOUNT_SID,
        },
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
          { to, bodyLength: body.length },
          "WhatsApp message sent via wa-bridge",
        )
      } else {
        baseLogger.error({ to, status: resp.status }, "wa-bridge send failed")
      }
      return ok
    } catch (error) {
      baseLogger.error({ error: String(error), to }, "wa-bridge send error")
      return false
    } finally {
      clearTimeout(timeout)
    }
  }
}

export const notificationService = new NotificationServiceImpl()
