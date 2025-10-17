import { InviteMethod } from "@domain/invite"
import { notificationService, NotificationMethod } from "@services/notification"
import { baseLogger } from "@services/logger"

const buildInviteLink = (token: string): string => {
  const firebaseDomain = process.env.FIREBASE_DYNAMIC_LINK_DOMAIN
  const appInstallUrl = process.env.APP_INSTALL_URL || "https://getflash.io/app"
  const androidPackage = process.env.ANDROID_PACKAGE_NAME || "com.lnflash"
  const iosBundleId = process.env.IOS_BUNDLE_ID || "com.lnflash"

  if (firebaseDomain) {
    const params = new URLSearchParams({
      link: `${appInstallUrl}?token=${token}`,
      apn: androidPackage,
      ibi: iosBundleId,
      st: "Flash App Invite",
      sd: "You've been invited to join Flash App",
      ofl: `https://getflash.io/invite?token=${token}`,
    })
    return `https://${firebaseDomain}/?${params.toString()}`
  }

  return `https://getflash.io/invite?token=${token}`
}

export const sendInviteNotification = async ({
  method,
  contact,
  token,
  senderName,
}: {
  method: InviteMethod
  contact: string
  token: string
  senderName: string
}): Promise<boolean> => {
  try {
    const inviteLink = buildInviteLink(token)

    // Convert InviteMethod to NotificationMethod
    const notificationMethod = method as unknown as NotificationMethod

    let messageBody: string
    let htmlBody: string | undefined

    switch (method) {
      case InviteMethod.EMAIL:
        messageBody = `${senderName} invited you to Flash`
        htmlBody = `
          <html>
            <body style="font-family: Arial, sans-serif;">
              <h2>You're Invited to Flash!</h2>
              <p>${senderName} has invited you to join Flash, your all-in-one wallet for fast, secure payments and rewards.</p>
              <p>Click the link below to get started:</p>
              <a href="${inviteLink}" style="display: inline-block; padding: 10px 20px; background-color: #4CAF50; color: white; text-decoration: none; border-radius: 5px;">Accept Invite</a>
              <p>Or copy this link: ${inviteLink}</p>
              <p>This invitation expires in 24 hours.</p>
            </body>
          </html>
        `
        break

      case InviteMethod.WHATSAPP:
        // For WhatsApp templates (if using approved templates)
        messageBody = JSON.stringify({
          templateName: "flash_invite",
          templateVariables: {
            "1": senderName,
            "2": token,
          },
        })
        break

      case InviteMethod.SMS:
      default:
        messageBody = `${senderName} invited you to Flash! Join using this link: ${inviteLink}`
        break
    }

    const success = await notificationService.sendNotification(
      notificationMethod,
      contact,
      messageBody,
      htmlBody,
    )

    if (success) {
      baseLogger.info(
        { method, contact, senderName },
        "Invite notification sent successfully",
      )
    } else {
      baseLogger.error(
        { method, contact, senderName },
        "Failed to send invite notification",
      )
    }

    return success
  } catch (error) {
    baseLogger.error(
      { error, method, contact, senderName },
      "Error sending invite notification",
    )
    return false
  }
}
