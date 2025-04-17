import Mailgun from 'mailgun.js';
import FormData from 'form-data'; // or built-in FormData
import { MailgunMessageData } from 'mailgun.js/definitions';
import { CashoutBody } from './templates/cashout';
import { Cashout, MailgunConfig } from '@config'
import { baseLogger } from '@services/logger';
import { CashoutDetails } from '@app/offers';

const config = Cashout.Email
const mailgun = new Mailgun(FormData).client({ username: 'api', key: MailgunConfig.apiKey });

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
        mailgun.messages.create(MailgunConfig.domain, msg);
      } catch (error) {
        baseLogger.error(error, "Failed to send email");
      }
  }
}

export = new EmailService()