import { InviteMethod } from "@domain/invite"
import { baseLogger } from "@services/logger"

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

  switch (method) {
    case InviteMethod.EMAIL:
      // TODO: Implement email sending
      baseLogger.info({ contact, inviteUrl, senderName }, "Would send email invite")
      break
    case InviteMethod.SMS:
      // TODO: Implement SMS sending
      baseLogger.info({ contact, inviteUrl, senderName }, "Would send SMS invite")
      break
    case InviteMethod.WHATSAPP:
      // TODO: Implement WhatsApp sending
      baseLogger.info({ contact, inviteUrl, senderName }, "Would send WhatsApp invite")
      break
  }

  return true
}