import { GT } from "@graphql/index"
import {
  InviteRepository,
  InviteMethod,
  InviteStatus,
} from "@services/mongoose/models/invite"
import { validateContactForMethod } from "@domain/invite"
import { generateInviteToken } from "@utils"
import { notificationService, NotificationMethod } from "@services/notification"
import { baseLogger } from "@services/logger"
import { redis } from "@services/redis"
import { Account } from "@services/mongoose/accounts"

const INVITE_EXPIRY_HOURS = 24
const MAX_INVITES_PER_DAY = 10
const MAX_INVITES_PER_TARGET_PER_DAY = 3

const InviteMethodEnum = GT.Enum({
  name: "InviteMethod",
  values: {
    EMAIL: { value: InviteMethod.EMAIL },
    SMS: { value: InviteMethod.SMS },
    WHATSAPP: { value: InviteMethod.WHATSAPP },
  },
})

const InviteStatusEnum = GT.Enum({
  name: "InviteStatus",
  values: {
    PENDING: { value: InviteStatus.PENDING },
    SENT: { value: InviteStatus.SENT },
    ACCEPTED: { value: InviteStatus.ACCEPTED },
    EXPIRED: { value: InviteStatus.EXPIRED },
  },
})

const InviteType = GT.Object({
  name: "Invite",
  fields: () => ({
    id: { type: GT.NonNull(GT.ID) },
    contact: { type: GT.NonNull(GT.String) },
    method: { type: GT.NonNull(InviteMethodEnum) },
    status: { type: GT.NonNull(InviteStatusEnum) },
    createdAt: { type: GT.NonNull(GT.String) },
    expiresAt: { type: GT.NonNull(GT.String) },
  }),
})

const CreateInviteInput = GT.Input({
  name: "CreateInviteInput",
  fields: () => ({
    contact: { type: GT.NonNull(GT.String) },
    method: { type: GT.NonNull(InviteMethodEnum) },
  }),
})

const CreateInvitePayload = GT.Object({
  name: "CreateInvitePayload",
  fields: () => ({
    invite: { type: InviteType },
    errors: { type: GT.NonNull(GT.List(GT.NonNull(GT.String))) },
  }),
})

const checkRateLimit = async (
  inviterId: string,
  targetContact: string,
): Promise<boolean> => {
  const today = new Date().toISOString().split("T")[0]

  const inviterKey = `invite:ratelimit:${inviterId}:${today}`
  const targetKey = `invite:ratelimit:target:${targetContact}:${today}`

  try {
    const [inviterCount, targetCount] = await Promise.all([
      redis.get(inviterKey),
      redis.get(targetKey),
    ])

    if (inviterCount && parseInt(inviterCount) >= MAX_INVITES_PER_DAY) {
      return false
    }

    if (targetCount && parseInt(targetCount) >= MAX_INVITES_PER_TARGET_PER_DAY) {
      return false
    }

    await Promise.all([
      redis.incr(inviterKey),
      redis.expire(inviterKey, 86400),
      redis.incr(targetKey),
      redis.expire(targetKey, 86400),
    ])

    return true
  } catch (error) {
    baseLogger.warn({ error }, "Redis rate limit check failed, using in-memory fallback")
    // TODO: Implement in-memory fallback for testing
    return true
  }
}

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

const CreateInviteMutation = GT.Field<null, GraphQLPublicContextAuth>({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(CreateInvitePayload),
  args: {
    input: { type: GT.NonNull(CreateInviteInput) },
  },
  resolve: async (_, args, { user }) => {
    const { contact, method } = args.input

    if (!user) {
      return { errors: ["Authentication required"], invite: null }
    }

    // Validate contact based on method
    const contactValidation = validateContactForMethod(contact, method)
    if (contactValidation !== true) {
      return { errors: [contactValidation.message], invite: null }
    }

    try {
      // Get account info
      const account = await Account.findOne({ kratosUserId: user.id })
      if (!account) {
        return { errors: ["Account not found"], invite: null }
      }

      // Check rate limits
      const rateLimitOk = await checkRateLimit(account._id.toString(), contact)
      if (!rateLimitOk) {
        return { errors: ["Rate limit exceeded. Please try again later."], invite: null }
      }

      // Generate token and hash
      const { token, tokenHash } = generateInviteToken()

      // Calculate expiry
      const expiresAt = new Date()
      expiresAt.setHours(expiresAt.getHours() + INVITE_EXPIRY_HOURS)

      // Create invite record
      const invite = new InviteRepository({
        contact,
        method,
        tokenHash,
        inviterId: account._id,
        status: InviteStatus.PENDING,
        createdAt: new Date(),
        expiresAt,
      })

      await invite.save()

      // Build invite link
      const inviteLink = buildInviteLink(token)

      // Prepare message content
      let messageBody: string
      let htmlBody: string | undefined

      // Get the sender's username or use "A friend" as fallback
      const senderName = account.username || "A friend"

      if (method === InviteMethod.EMAIL) {
        messageBody = `${
          senderName.charAt(0).toUpperCase() + senderName.slice(1)
        } invited you to Flash`
        htmlBody = `
          <html>
            <body style="font-family: Arial, sans-serif;">
              <h2>You're Invited to Flash!</h2>
              <p>${
                senderName.charAt(0).toUpperCase() + senderName.slice(1)
              } has invited you to join Flash, your all-in-one wallet for fast, secure payments and rewards.</p>
              <p>Click the link below to get started:</p>
              <a href="${inviteLink}" style="display: inline-block; padding: 10px 20px; background-color: #4CAF50; color: white; text-decoration: none; border-radius: 5px;">Accept Invite</a>
              <p>Or copy this link: ${inviteLink}</p>
              <p>This invitation expires in 24 hours.</p>
            </body>
          </html>
        `
      } else if (method === InviteMethod.WHATSAPP) {
        // For WhatsApp, we'll pass the template variables to the notification service
        // The actual message body will be handled by the template
        messageBody = JSON.stringify({
          templateName: "flash_invite", // You'll need to use your actual template name
          templateVariables: {
            "1": senderName, // {{1}} maps to name
            "2": token, // {{2}} maps to token (the actual token, not the link)
          },
        })
      } else {
        // SMS
        messageBody = `${senderName} invited you to Flash! Join using this link: ${inviteLink}`
      }

      // Send notification
      const notificationMethod = method as unknown as NotificationMethod
      const sent = await notificationService.sendNotification(
        notificationMethod,
        contact,
        messageBody,
        htmlBody,
      )

      if (sent) {
        invite.status = InviteStatus.SENT
        await invite.save()
      }

      return {
        errors: sent ? [] : ["Failed to send invitation"],
        invite: sent
          ? {
              id: invite._id.toString(),
              contact: invite.contact,
              method: invite.method,
              status: invite.status,
              createdAt: invite.createdAt.toISOString(),
              expiresAt: invite.expiresAt.toISOString(),
            }
          : null,
      }
    } catch (error) {
      baseLogger.error({ error }, "Failed to create invite")
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error occurred"
      return {
        errors: [errorMessage],
        invite: null,
      }
    }
  },
})

export default CreateInviteMutation
