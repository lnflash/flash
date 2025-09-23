import sgMail from "@sendgrid/mail"

import { Cashout, SendGridConfig } from "@config"
import { baseLogger } from "@services/logger"
import { CashoutDetails } from "@app/offers"

import { CashoutBody } from "./templates/cashout"

type EmailHeaders = {
  to: string
  from: string
  subject: string
  text: string
  html?: string
}

const config = Cashout.Email
sgMail.setApiKey(SendGridConfig.apiKey)

class EmailService {
  sendCashoutInitiatedEmail = async (username: Username, offer: CashoutDetails) => {
    const body = CashoutBody({
      ...offer,
      username,
      formattedDate: new Date().toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "numeric",
        hour12: true,
      }),
    })
    this.sendEmail({
      to: config.to,
      from: config.from,
      subject: config.subject,
      text: body.text,
      html: body.html,
    } as EmailHeaders)
  }

  // SendGrid send
  private sendEmail = async (msg: EmailHeaders): Promise<void> => {
    try {
      await sgMail.send(msg)
      baseLogger.info({ to: msg.to }, "Email sent successfully via SendGrid")
    } catch (error) {
      baseLogger.error(error, "Failed to send email via SendGrid")
    }
  }
}

export = new EmailService()
