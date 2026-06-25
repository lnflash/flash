import express, { Request, Response } from "express"
import { baseLogger as logger } from "@services/logger"
import { RELAY_WEBHOOK_SECRET } from "@config"
import { checkValidNpub } from "@domain/nostr"
import { AccountsRepository, UsersRepository } from "@services/mongoose"
import { NotificationsService } from "@services/notifications"
import { RepositoryError } from "@domain/errors"

const authenticate = (req: Request, res: Response): boolean => {
  if (!RELAY_WEBHOOK_SECRET) {
    res.status(503).end("Relay webhook not configured")
    return false
  }
  const auth = req.headers["authorization"]
  if (!auth || auth !== `Bearer ${RELAY_WEBHOOK_SECRET}`) {
    res.status(401).end("Unauthorized")
    return false
  }
  return true
}

export const paths = {
  notify: "/relay/notify",
}

const router = express.Router()

router.post(paths.notify, async (req: Request, res: Response) => {
  if (!authenticate(req, res)) return

  const { npub, title, body } = req.body

  if (typeof npub !== "string" || !checkValidNpub(npub)) {
    res.status(400).json({ error: "Invalid or missing npub" })
    return
  }

  if (typeof body !== "string" || body.trim().length === 0) {
    res.status(400).json({ error: "Missing notification body" })
    return
  }

  logger.info({ npub, title }, "Relay requested notification delivery")

  const account = await AccountsRepository().findByNpub(npub as Npub)
  if (account instanceof RepositoryError) {
    logger.warn({ npub }, "No account found for npub")
    res.status(404).json({ error: "No account found for this npub" })
    return
  }

  const user = await UsersRepository().findById(account.kratosUserId)
  if (user instanceof Error) {
    logger.error({ err: user, npub }, "Failed to fetch user for npub notification")
    res.status(500).json({ error: "Failed to fetch user" })
    return
  }

  if (!user.deviceTokens || user.deviceTokens.length === 0) {
    res.status(400).json({ error: "User has no registered device tokens" })
    return
  }

  const notifResult = await NotificationsService().adminPushNotificationSend({
    deviceTokens: user.deviceTokens,
    title: typeof title === "string" ? title : "New Message",
    body,
  })

  if (notifResult instanceof Error) {
    logger.error({ err: notifResult, npub }, "Failed to send push notification")
    res.status(500).json({ error: "Failed to send notification" })
    return
  }

  res.status(200).json({ ok: true })
})

export { router }
