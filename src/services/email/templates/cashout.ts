import { CashoutDetails } from "@app/offers"
import { JMDAmount, USDAmount } from "@domain/shared"

type CashoutBodyArgs = CashoutDetails & {
  username: string
  customerName: string
  cashoutId: string
  erpNextLink: string
  formattedDate: string
}

export const CashoutBody = (args: CashoutBodyArgs) => {
  const payoutCurrency = args.payout.amount instanceof JMDAmount ? "JMD" : "USD"
  const payoutString = `${args.payout.amount.asDollars()} ${payoutCurrency}`

  const serviceFeeString =
    args.payout.serviceFee instanceof USDAmount
      ? args.payout.serviceFee.asDollars()
      : null

  const feeDetails = serviceFeeString ? `Service fee: $${serviceFeeString} USD` : ""

  return {
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Flash Cashout Notification — ${args.cashoutId}</title>
      </head>
      <body style="margin: 0; padding: 0; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #333333; background-color: #f7f7f7;">
        <!-- Header -->
        <div style="background-color: #0066cc; padding: 20px; text-align: center;">
          <h1 style="margin: 0; color: white; font-size: 28px; font-weight: 700; letter-spacing: 1px;">FLASH</h1>
          <p style="margin: 5px 0 0; color: rgba(255,255,255,0.9); font-size: 16px;">Cashout Initiated — ${args.cashoutId}</p>
        </div>
        
        <!-- Content -->
        <div style="background-color: white; padding: 25px; border-radius: 5px; margin: 20px; box-shadow: 0 2px 5px rgba(0,0,0,0.05);">
          <h2 style="margin: 0 0 20px; color: #0066cc; font-size: 20px;">Transaction Details</h2>
          
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 10px 5px; border-bottom: 1px solid #eeeeee; width: 40%; color: #666666; font-weight: 500;">Cashout ID</td>
              <td style="padding: 10px 5px; border-bottom: 1px solid #eeeeee; font-weight: 600; font-family: monospace;">${args.cashoutId}</td>
            </tr>
            <tr>
              <td style="padding: 10px 5px; border-bottom: 1px solid #eeeeee; width: 40%; color: #666666; font-weight: 500;">ERPNext Link</td>
              <td style="padding: 10px 5px; border-bottom: 1px solid #eeeeee;"><a href="${args.erpNextLink}" style="color: #0066cc;">${args.erpNextLink}</a></td>
            </tr>
            <tr>
              <td style="padding: 10px 5px; border-bottom: 1px solid #eeeeee; width: 40%; color: #666666; font-weight: 500;">Ibex Payment</td>
              <td style="padding: 10px 5px; border-bottom: 1px solid #eeeeee; font-weight: 600; font-family: monospace; font-size: 13px;">${args.payment.invoice.paymentHash}</td>
            </tr>
            <tr>
              <td style="padding: 10px 5px; border-bottom: 1px solid #eeeeee; width: 40%; color: #666666; font-weight: 500;">Payout Amount</td>
              <td style="padding: 10px 5px; border-bottom: 1px solid #eeeeee; font-weight: 600;">${payoutString}</td>
            </tr>
            ${
              serviceFeeString
                ? `
            <tr>
              <td style="padding: 10px 5px; border-bottom: 1px solid #eeeeee; width: 40%; color: #666666; font-weight: 500;">Service Fee</td>
              <td style="padding: 10px 5px; border-bottom: 1px solid #eeeeee;">$${serviceFeeString} USD</td>
            </tr>`
                : ""
            }
            <tr>
              <td style="padding: 10px 5px; border-bottom: 1px solid #eeeeee; width: 40%; color: #666666; font-weight: 500;">Date & Time</td>
              <td style="padding: 10px 5px; border-bottom: 1px solid #eeeeee;">${args.formattedDate}</td>
            </tr>
          </table>
          
          <div style="margin-top: 30px;">
            <h3 style="margin: 0 0 15px; color: #0066cc; font-size: 16px;">User Information</h3>
            <table style="width: 100%; border-collapse: collapse; background-color: #f9f9f9; border-radius: 4px;">
              <tr>
                <td style="padding: 8px 5px; color: #666666; font-weight: 500; width: 40%;">Customer</td>
                <td style="padding: 8px 5px; font-weight: 600;">${args.customerName}</td>
              </tr>
              <tr>
                <td style="padding: 8px 5px; color: #666666; font-weight: 500;">Username</td>
                <td style="padding: 8px 5px;">${args.username}</td>
              </tr>
              <tr>
                <td style="padding: 8px 5px; color: #666666; font-weight: 500;">Wallet ID</td>
                <td style="padding: 8px 5px; font-size: 13px; font-family: monospace;">${args.payment.userAcct}</td>
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
    `,
    text: `
      FLASH - Cashout Initiated [${args.cashoutId}]

      ERPNext: ${args.erpNextLink}

      Transaction Details:
      --------------------
      Cashout ID: ${args.cashoutId}
      Ibex Payment: ${args.payment.invoice.paymentHash}
      Payout Amount: ${payoutString}
      ${feeDetails}
      Date & Time: ${args.formattedDate}

      User Information:
      -------------------
      Customer: ${args.customerName}
      Username: ${args.username}
      Wallet ID: ${args.payment.userAcct}

      ----------------------
      This is an automated notification from Flash. Please do not reply to this email.
      © ${new Date().getFullYear()} Flash. All rights reserved.
    `,
  }
}
