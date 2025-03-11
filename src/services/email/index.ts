// src/services/email/index.ts
import axios from "axios"
import { baseLogger } from "@services/logger"
import { wrapAsyncFunctionsToRunInSpan } from "@services/tracing"

const logger = baseLogger.child({ module: "email-service" })

// Email service providers
enum EmailProvider {
  SENDGRID = "sendgrid",
  MAILGUN = "mailgun",
  CUSTOM = "custom",
}

const getEmailProvider = (): EmailProvider => {
  const provider = process.env.EMAIL_PROVIDER?.toLowerCase() || "sendgrid"
  if (provider === "mailgun") return EmailProvider.MAILGUN
  if (provider === "custom") return EmailProvider.CUSTOM
  return EmailProvider.SENDGRID
}

export const EmailService = () => {
  const sendLightningTransactionEmail = async ({
    senderWalletId,
    recipientWalletId,
    senderUsername, // Add this parameter
    recipientUsername, // Add this parameter
    senderPhone, // Add this parameter
    recipientPhone, // Add this parameter
    amount,
    memo,
  }: {
    senderWalletId: WalletId
    recipientWalletId: WalletId
    senderUsername: string
    recipientUsername: string
    senderPhone: string
    recipientPhone: string
    amount: { amount: number; currency: string }
    memo?: string
  }) => {
    try {
      const provider = getEmailProvider()
      const timestamp = new Date().toISOString()
      const formattedDate = new Date().toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "numeric",
        hour12: true,
      })
      const emailContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Flash Transaction Notification</title>
      </head>
      <body style="margin: 0; padding: 0; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #333333; background-color: #f7f7f7;">
        <!-- Header -->
        <div style="background-color: #0066cc; padding: 20px; text-align: center;">
          <h1 style="margin: 0; color: white; font-size: 28px; font-weight: 700; letter-spacing: 1px;">FLASH</h1>
          <p style="margin: 5px 0 0; color: rgba(255,255,255,0.9); font-size: 16px;">Lightning Network Transaction</p>
        </div>
        
        <!-- Content -->
        <div style="background-color: white; padding: 25px; border-radius: 5px; margin: 20px; box-shadow: 0 2px 5px rgba(0,0,0,0.05);">
          <h2 style="margin: 0 0 20px; color: #0066cc; font-size: 20px;">Transaction Details</h2>
          
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 10px 5px; border-bottom: 1px solid #eeeeee; width: 40%; color: #666666; font-weight: 500;">Amount</td>
              <td style="padding: 10px 5px; border-bottom: 1px solid #eeeeee; font-weight: 600;">${
                amount.amount
              } ${amount.currency}</td>
            </tr>
            <tr>
              <td style="padding: 10px 5px; border-bottom: 1px solid #eeeeee; width: 40%; color: #666666; font-weight: 500;">Date & Time</td>
              <td style="padding: 10px 5px; border-bottom: 1px solid #eeeeee;">${formattedDate}</td>
            </tr>
            <tr>
              <td style="padding: 10px 5px; border-bottom: 1px solid #eeeeee; width: 40%; color: #666666; font-weight: 500;">Memo</td>
              <td style="padding: 10px 5px; border-bottom: 1px solid #eeeeee;">${
                memo || "N/A"
              }</td>
            </tr>
          </table>
          
          <div style="margin-top: 30px;">
            <h3 style="margin: 0 0 15px; color: #0066cc; font-size: 16px;">Sender Information</h3>
            <table style="width: 100%; border-collapse: collapse; background-color: #f9f9f9; border-radius: 4px;">
              <tr>
                <td style="padding: 8px 5px; color: #666666; font-weight: 500; width: 40%;">Username</td>
                <td style="padding: 8px 5px;">${senderUsername}</td>
              </tr>
              <tr>
                <td style="padding: 8px 5px; color: #666666; font-weight: 500;">Phone</td>
                <td style="padding: 8px 5px;">${senderPhone}</td>
              </tr>
              <tr>
                <td style="padding: 8px 5px; color: #666666; font-weight: 500;">Wallet ID</td>
                <td style="padding: 8px 5px; font-size: 13px; font-family: monospace;">${senderWalletId}</td>
              </tr>
            </table>
          </div>
          
          <div style="margin-top: 30px;">
            <h3 style="margin: 0 0 15px; color: #0066cc; font-size: 16px;">Recipient Information</h3>
            <table style="width: 100%; border-collapse: collapse; background-color: #f9f9f9; border-radius: 4px;">
              <tr>
                <td style="padding: 8px 5px; color: #666666; font-weight: 500; width: 40%;">Username</td>
                <td style="padding: 8px 5px;">${recipientUsername}</td>
              </tr>
              <tr>
                <td style="padding: 8px 5px; color: #666666; font-weight: 500;">Phone</td>
                <td style="padding: 8px 5px;">${recipientPhone}</td>
              </tr>
              <tr>
                <td style="padding: 8px 5px; color: #666666; font-weight: 500;">Wallet ID</td>
                <td style="padding: 8px 5px; font-size: 13px; font-family: monospace;">${recipientWalletId}</td>
              </tr>
            </table>
          </div>
        </div>
        
        <!-- Footer -->
        <div style="padding: 20px; text-align: center; font-size: 12px; color: #888888;">
          <p>This is an automated notification from Flash. Please do not reply to this email.</p>
          <p>&copy; ${new Date().getFullYear()} Flash. All rights reserved.</p>
        </div>
      </body>
      </html>
    `

      // Define variables outside of switch
      const mailgunDomain = process.env.MAILGUN_DOMAIN || ""

      switch (provider) {
        case EmailProvider.SENDGRID: {
          await axios.post(
            "https://api.sendgrid.com/v3/mail/send",
            {
              personalizations: [{ to: [{ email: "transactions@getflash.io" }] }],
              from: { email: process.env.EMAIL_FROM || "notifications@getflash.io" },
              subject: "New Flash Transaction",
              content: [{ type: "text/html", value: emailContent }],
            },
            {
              headers: { Authorization: `Bearer ${process.env.SENDGRID_API_KEY}` },
            },
          )
          break
        }

        case EmailProvider.MAILGUN: {
          await axios.post(
            `https://api.mailgun.net/v3/${mailgunDomain}/messages`,
            new URLSearchParams({
              from: process.env.EMAIL_FROM || "notifications@getflash.io",
              to: "transactions@getflash.io",
              subject: "New Flash Transaction",
              html: emailContent,
            }),
            {
              auth: {
                username: "api",
                password: process.env.MAILGUN_API_KEY || "",
              },
            },
          )
          break
        }

        case EmailProvider.CUSTOM: {
          await axios.post(
            process.env.CUSTOM_EMAIL_API_URL || "",
            {
              to: "transactions@getflash.io",
              from: process.env.EMAIL_FROM || "notifications@mail.getflash.io",
              subject: "New Flash Transaction",
              html: emailContent,
            },
            {
              headers: JSON.parse(process.env.CUSTOM_EMAIL_API_HEADERS || "{}"),
            },
          )
          break
        }
      }

      logger.info(
        {
          senderWalletId,
          recipientWalletId,
          provider,
        },
        "Lightning transaction email sent successfully",
      )

      return true
    } catch (error) {
      logger.error(
        {
          error,
          senderWalletId,
          recipientWalletId,
        },
        "Failed to send lightning transaction email",
      )

      return error
    }
  }

  return wrapAsyncFunctionsToRunInSpan({
    namespace: "services.email",
    fns: {
      sendLightningTransactionEmail,
    },
  })
}
