import { removeDeviceTokens } from "@app/users/remove-device-tokens"
import {
  AllDeviceTokensStaleNotificationsServiceError,
  DeviceTokensNotRegisteredNotificationsServiceError,
  FlashNotificationCategories,
  InvalidDeviceNotificationsServiceError,
  NoDeviceAcceptedPushNotificationsServiceError,
  RecipientDisabledNotificationsServiceError,
} from "@domain/notifications"
import { baseLogger } from "@services/logger"
import { AccountsRepository } from "@services/mongoose/accounts"
import { UsersRepository } from "@services/mongoose/users"
import {
  PushNotificationsService,
  SendFilteredPushNotificationStatus,
} from "@services/notifications/push-notifications"

export const sendUserNotification = async ({
  accountId,
  title,
  body,
  sentBy,
}: {
  accountId: AccountUuid
  title: string
  body: string
  // The admin/support user who triggered this send. Required — see the audit
  // log below for why it cannot be optional.
  sentBy: UserId
}): Promise<true | ApplicationError> => {
  const account = await AccountsRepository().findByUuid(accountId)
  if (account instanceof Error) return account

  const user = await UsersRepository().findById(account.kratosUserId)
  if (user instanceof Error) return user

  // Audit trail. `sentBy` is the only operator attribution this send gets — the
  // admin server builds no gqlContext for PinoHttp to log. `body` is on the line
  // because it is what lands on the user's lock screen, and it is
  // operator-authored text, not user PII. Emitted before the send so the record
  // survives a failure mid-delivery.
  baseLogger.info(
    { accountId, sentBy, title, body, deviceTokenCount: user.deviceTokens.length },
    "admin user notification requested",
  )

  // The "requested" line counts attempts; every terminal path below logs an
  // outcome, so a grep cannot read a refused or failed send as a delivery.
  const logOutcome = (outcome: string, extra?: Record<string, unknown>) =>
    baseLogger.info(
      { accountId, sentBy, outcome, ...extra },
      "admin user notification result",
    )

  // Filtered, not raw: every other user-facing push in the codebase honors the
  // recipient's notification settings, and the domain already models this
  // category. A user who turned push off must not receive one anyway.
  const result = await PushNotificationsService().sendFilteredNotification({
    deviceTokens: user.deviceTokens,
    title,
    body,
    notificationCategory: FlashNotificationCategories.AdminPushNotification,
    notificationSettings: account.notificationSettings,
  })

  // Firebase reports stale (uninstalled/reinstalled) tokens as an error even
  // when delivery to the user's live tokens succeeded. Prune them like every
  // other push caller does, and only report success when Firebase says at
  // least one device actually accepted the push.
  if (result instanceof DeviceTokensNotRegisteredNotificationsServiceError) {
    const pruned = await removeDeviceTokens({
      userId: account.kratosUserId,
      deviceTokens: result.tokens,
    })
    if (pruned instanceof Error) {
      baseLogger.warn({ accountId, err: pruned }, "failed to prune stale device tokens")
    }

    if (result.successCount > 0) {
      logOutcome("delivered-with-stale-tokens-pruned")
      return true
    }

    // "All stale" has to actually mean all stale: if only some tokens were
    // stale, the rest failed for another reason, and "ask them to reopen the
    // app" sends the operator to the user for a problem the user cannot fix.
    if (result.tokens.length === user.deviceTokens.length) {
      logOutcome("all-device-tokens-stale")
      return new AllDeviceTokensStaleNotificationsServiceError()
    }

    logOutcome("no-device-accepted", { failureCodes: result.failureCodes })
    return new NoDeviceAcceptedPushNotificationsServiceError(
      "no device accepted the push",
      result.failureCodes,
    )
  }

  // Every token failed for a non-stale reason. Logged as its own outcome rather
  // than folded into "send-failed" so the escalation carries the FCM codes.
  if (result instanceof NoDeviceAcceptedPushNotificationsServiceError) {
    logOutcome("no-device-accepted", { failureCodes: result.failureCodes })
    return result
  }

  // The user has no registered device tokens at all — nothing was handed to
  // Firebase. This is the most common terminal state on a support-initiated
  // send and it is routine, not a fault. Folding it into "send-failed" would
  // put it under the same label as "Firebase module not loaded" and a Google
  // 5xx, so an alert on the one outcome that reads as "something broke" would
  // fire on every attempt at a user who never enabled push, get muted, and
  // then hide a real outage. The API already reports these distinctly
  // (PUSH_NO_DEVICE_TOKENS vs UNEXPECTED_CLIENT_ERROR); the log must too.
  if (result instanceof InvalidDeviceNotificationsServiceError) {
    logOutcome("no-device-tokens")
    return result
  }

  if (result instanceof Error) {
    logOutcome("send-failed")
    return result
  }

  if (result.status === SendFilteredPushNotificationStatus.Filtered) {
    logOutcome("filtered-recipient-opted-out")
    return new RecipientDisabledNotificationsServiceError()
  }

  logOutcome("delivered")
  return true
}
