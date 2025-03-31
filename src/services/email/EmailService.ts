import Mailgun from 'mailgun.js';
import FormData from 'form-data'; // or built-in FormData
import { MailgunMessageData } from 'mailgun.js/definitions';
import { CashoutBody } from './templates/cashout';
import { Cashout, MAILGUN_API_KEY, MAILGUN_DOMAIN } from '@config'
import { baseLogger } from '@services/logger';

const config = Cashout.Email
const mailgun = new Mailgun(FormData).client({ username: 'api', key: MAILGUN_API_KEY })

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
      })
    })
    this.sendEmail({
      to: config.to,
      from: config.from, 
      subject: config.subject,
      text: body.text,
      html: body.html,
    })
  }

  // Mailgun send
  private sendEmail = async (msg: MailgunMessageData): Promise<void> => {
      try {
        mailgun.messages.create(MAILGUN_DOMAIN, msg);
      } catch (error) {
        baseLogger.error(error, "Failed to send email");
      }
  }
}

export = new EmailService()