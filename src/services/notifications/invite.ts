import { InviteMethod } from "@domain/invite"
import { baseLogger } from "@services/logger"
import { notificationService, NotificationMethod } from "@services/notification"

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
}) => {
  const inviteUrl = `https://getflash.io/invite?token=${token}`
  const message = `${senderName} invited you to Flash! Join now: ${inviteUrl}`

  let success = false

  switch (method) {
    case InviteMethod.EMAIL:
      const subject = `${senderName} invited you to Flash!`
      const htmlBody = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>You're invited to Flash!</h2>
          <p>Hi there,</p>
          <p>${senderName} has invited you to join Flash, the lightning-fast Bitcoin payment app.</p>
          <p>Click the link below to accept the invitation and get started:</p>
          <p style="margin: 20px 0;">
            <a href="${inviteUrl}" style="background-color: #4CAF50; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block;">
              Accept Invitation
            </a>
          </p>
          <p>Or copy this link: ${inviteUrl}</p>
          <p>Best regards,<br>The Flash Team</p>
        </div>
      `
      success = await notificationService.sendNotification(
        NotificationMethod.EMAIL,
        contact,
        subject,
        htmlBody
      )
      if (success) {
        baseLogger.info({ method: "email", senderName }, "Invite notification sent")
      }
      break
      
    case InviteMethod.SMS:
      success = await notificationService.sendNotification(
        NotificationMethod.SMS,
        contact,
        message
      )
      if (success) {
        baseLogger.info({ method: "sms", senderName }, "Invite notification sent")
      }
      break
      
    case InviteMethod.WHATSAPP:
      // Try to use WhatsApp template if configured
      const templateMessage = {
        templateName: "invite_friend",
        templateVariables: {
          1: senderName,
          2: inviteUrl
        }
      }
      
      // First try with template, fallback to regular message
      success = await notificationService.sendNotification(
        NotificationMethod.WHATSAPP,
        contact,
        JSON.stringify(templateMessage)
      )
      
      if (!success) {
        // Fallback to regular message
        success = await notificationService.sendNotification(
          NotificationMethod.WHATSAPP,
          contact,
          message
        )
      }
      
      if (success) {
        baseLogger.info({ method: "whatsapp", senderName }, "Invite notification sent")
      }
      break
  }

  if (!success) {
    baseLogger.error({ method, senderName }, "Failed to send invite notification")
  }

  return success
}