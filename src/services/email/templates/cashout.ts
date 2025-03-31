type CashoutBodyArgs = CashoutDetails & { username: Username, formattedDate: string }

export const CashoutBody = (args: CashoutBodyArgs) => {
  const usdString = `${Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(args.liability.usd.amount) / 100)} USD`  
  
  const jmdString = `${args.liability.jmd.amount} JMD`

  return {
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Flash Cashout Notification</title>
      </head>
      <body style="margin: 0; padding: 0; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #333333; background-color: #f7f7f7;">
        <!-- Header -->
        <div style="background-color: #0066cc; padding: 20px; text-align: center;">
          <h1 style="margin: 0; color: white; font-size: 28px; font-weight: 700; letter-spacing: 1px;">FLASH</h1>
          <p style="margin: 5px 0 0; color: rgba(255,255,255,0.9); font-size: 16px;">Received Cashout Transaction</p>
        </div>
        
        <!-- Content -->
        <div style="background-color: white; padding: 25px; border-radius: 5px; margin: 20px; box-shadow: 0 2px 5px rgba(0,0,0,0.05);">
          <h2 style="margin: 0 0 20px; color: #0066cc; font-size: 20px;">Transaction Details</h2>
          
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 10px 5px; border-bottom: 1px solid #eeeeee; width: 40%; color: #666666; font-weight: 500;">Ibex Payment</td>
              <td style="padding: 10px 5px; border-bottom: 1px solid #eeeeee; font-weight: 600;">${args.ibexTrx.invoice.paymentHash}</td>
            </tr>
            <tr>
              <td style="padding: 10px 5px; border-bottom: 1px solid #eeeeee; width: 40%; color: #666666; font-weight: 500;">Owed to user</td>
              <td style="padding: 10px 5px; border-bottom: 1px solid #eeeeee; font-weight: 600;">
                ${usdString} 
                OR 
                ${jmdString} 
              </td>
            </tr>
            <tr>
              <td style="padding: 10px 5px; border-bottom: 1px solid #eeeeee; width: 40%; color: #666666; font-weight: 500;">Date & Time</td>
              <td style="padding: 10px 5px; border-bottom: 1px solid #eeeeee;">${args.formattedDate}</td>
            </tr>
          </table>
          
          <div style="margin-top: 30px;">
            <h3 style="margin: 0 0 15px; color: #0066cc; font-size: 16px;">User Information</h3>
            <table style="width: 100%; border-collapse: collapse; background-color: #f9f9f9; border-radius: 4px;">
              <tr>
                <td style="padding: 8px 5px; color: #666666; font-weight: 500; width: 40%;">Username</td>
                <td style="padding: 8px 5px;">${args.username}</td>
              </tr>
              <tr>
                <td style="padding: 8px 5px; color: #666666; font-weight: 500;">Wallet ID</td>
                <td style="padding: 8px 5px; font-size: 13px; font-family: monospace;">${args.ibexTrx.userAcct}</td>
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
      FLASH - Cashout Initiated 

      Transaction Details:
      --------------------
      Ibex Payment: ${args.ibexTrx.invoice.paymentHash}
      Amount owed: ${usdString} 
        OR ${jmdString} 
      Date & Time: ${args.formattedDate}

      User Information:
      -------------------
      Username: ${args.username}
      Wallet ID: ${args.ibexTrx.userAcct}

      ----------------------
      This is an automated notification from Flash. Please do not reply to this email.
      © ${new Date().getFullYear()} Flash. All rights reserved.
    `
  }
}