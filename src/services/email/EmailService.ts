import sgMail from "@sendgrid/mail"

import { Cashout, FrappeConfig, SendGridConfig } from "@config"
import { baseLogger } from "@services/logger"

import { InitiatedCashout } from "@app/offers/ValidOffer"
import { formatRiskLines, hasRiskWarning } from "@app/offers/risk-signals/signals"

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
  sendCashoutInitiatedEmail = async (cashout: InitiatedCashout) => {
    const account = cashout.offer.account

    const username = account.username ?? ""
    const customerName = account.erpParty ?? username
    const cashoutId = cashout.cashoutId
    const erpNextLink = `${FrappeConfig.url}/app/cashout/${cashoutId}`
    // Risk signals (ENG-889). This notice goes only to the internal ops inbox
    // (Cashout.Email.to), never to the customer.
    const riskSignals = cashout.riskSignals ?? { available: false as const }
    const riskLines = formatRiskLines(riskSignals)

    const body = CashoutBody({
      ...cashout.offer.details,
      username,
      customerName,
      cashoutId,
      erpNextLink,
      formattedDate: new Date().toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "numeric",
        hour12: true,
      }),
      riskLines,
    })
    this.sendEmail({
      to: config.to,
      from: config.from,
      subject: hasRiskWarning(riskSignals)
        ? `[RISK FLAGS] ${config.subject}`
        : config.subject,
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
