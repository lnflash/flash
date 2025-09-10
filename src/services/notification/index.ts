import twilio from "twilio"
import Mailgun from "mailgun.js"
import FormData from "form-data"
import { baseLogger } from "@services/logger"
import { env, MailgunConfig } from "@config"

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
  private mailgunClient: any = null

  constructor() {
    this.initializeTwilio()
    this.initializeMailgun()
  }

  private initializeTwilio() {
    try {
      if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) {
        this.twilioClient = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN)
      }
    } catch (error) {
      baseLogger.error({ error }, "Failed to initialize Twilio client")
    }
  }

  private initializeMailgun() {
    try {
      if (MailgunConfig?.apiKey) {
        const mailgun = new Mailgun(FormData)
        this.mailgunClient = mailgun.client({
          username: "api",
          key: MailgunConfig.apiKey,
        })
      }
    } catch (error) {
      baseLogger.error({ error }, "Failed to initialize Mailgun client")
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
    if (!this.mailgunClient) {
      baseLogger.error("Mailgun client not configured")
      return false
    }

    // Use environment variable for from address, or default
    const fromEmail = process.env.MAILGUN_FROM_EMAIL || "noreply@getflash.io"
    const domain = MailgunConfig?.domain

    if (!domain) {
      baseLogger.error("Mailgun domain not configured")
      return false
    }

    try {
      await this.mailgunClient.messages.create(domain, {
        from: fromEmail,
        to: [to],
        subject: subject,
        text: subject,
        html: htmlBody || subject,
      })

      baseLogger.info({ to }, "Email sent successfully via Mailgun")
      return true
    } catch (error) {
      baseLogger.error({ error, to }, "Failed to send email via Mailgun")
      return false
    }
  }

  private async sendSMS(to: string, body: string): Promise<boolean> {
    if (!this.twilioClient) {
      baseLogger.error("Twilio client not configured")
      return false
    }

    const twilioFrom = process.env.TWILIO_FROM
    if (!twilioFrom) {
      baseLogger.error("TWILIO_FROM not configured")
      return false
    }

    try {
      await this.twilioClient.messages.create({
        body,
        from: twilioFrom,
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
    if (!this.twilioClient) {
      baseLogger.error("Twilio client not configured")
      return false
    }

    const twilioWhatsAppFrom = process.env.TWILIO_WHATSAPP_FROM
    if (!twilioWhatsAppFrom) {
      baseLogger.error("TWILIO_WHATSAPP_FROM not configured")
      return false
    }

    const whatsappTo = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`
    const whatsappFrom = twilioWhatsAppFrom.startsWith("whatsapp:")
      ? twilioWhatsAppFrom
      : `whatsapp:${twilioWhatsAppFrom}`

    try {
      await this.twilioClient.messages.create({
        body,
        from: whatsappFrom,
        to: whatsappTo,
      })
      baseLogger.info({ to: whatsappTo }, "WhatsApp message sent successfully via Twilio")
      return true
    } catch (error) {
      baseLogger.error({ error, to: whatsappTo }, "Failed to send WhatsApp message")
      return false
    }
  }
}

export const notificationService = new NotificationServiceImpl()
