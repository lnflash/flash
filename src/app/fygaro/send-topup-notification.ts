import { getI18nInstance } from "@config"
import { checkedToAccountId } from "@domain/accounts"
import { getLanguageOrDefault } from "@domain/locale"
import {
  DeviceTokensNotRegisteredNotificationsServiceError,
  FlashNotificationCategories,
  NotificationsServiceError,
} from "@domain/notifications"
import { removeDeviceTokens } from "@app/users/remove-device-tokens"
import { baseLogger } from "@services/logger"
import { AccountsRepository } from "@services/mongoose/accounts"
import { UsersRepository } from "@services/mongoose/users"
import {
  PushNotificationsService,
  SendFilteredPushNotificationStatus,
} from "@services/notifications/push-notifications"

const i18n = getI18nInstance()

/**
 * Tell the customer how their card top-up ended.
 *
 * This exists to make an app promise true. After a payment the app now says
 * "We've received your payment and are crediting your wallet — we'll let you
 * know as soon as it lands", because a credit can outlive the screen: the
 * transient webhook paths deliberately 500 so Fygaro retries, which can take
 * minutes. Without this, that sentence is a promise nothing keeps.
 *
 * BOTH terminal outcomes notify, and that is deliberate. Sending only on
 * success would keep the promise exactly when it costs nothing and break it in
 * the case that actually matters — the customer whose money was captured and
 * not credited, who is otherwise left watching a screen that said we would be
 * in touch.
 */
export type FygaroTopupNotificationOutcome = "credited" | "heldForReview"

const formatUsd = (cents: number): string => `$${(cents / 100).toFixed(2)}`

export const sendFygaroTopupNotification = async ({
  accountId: accountIdRaw,
  outcome,
  amountCents,
}: {
  accountId: string
  outcome: FygaroTopupNotificationOutcome
  // The NET credited for `credited`, the gross captured for `heldForReview` —
  // in both cases the number the customer would recognise as "the amount this
  // is about".
  amountCents: number
}): Promise<true | ApplicationError> => {
  const accountId = checkedToAccountId(accountIdRaw)
  if (accountId instanceof Error) return accountId

  const account = await AccountsRepository().findById(accountId)
  if (account instanceof Error) return account

  const user = await UsersRepository().findById(account.kratosUserId)
  if (user instanceof Error) return user

  const locale = getLanguageOrDefault(user.language)
  const phraseBase = `notification.fygaroTopup.${outcome}`

  const title = i18n.__({ phrase: `${phraseBase}.title`, locale })
  const body = i18n.__(
    { phrase: `${phraseBase}.body`, locale },
    { amount: formatUsd(amountCents) },
  )

  const result = await PushNotificationsService().sendFilteredNotification({
    deviceTokens: user.deviceTokens,
    title,
    body,
    notificationCategory: FlashNotificationCategories.Payments,
    notificationSettings: account.notificationSettings,
    data: {
      type: `fygaro_topup_${outcome}`,
      amount: String(amountCents),
      currency: "USD",
    },
  })

  if (result instanceof NotificationsServiceError) return result

  if (result.status === SendFilteredPushNotificationStatus.Filtered) {
    return true
  }

  return true
}

/**
 * Fire-and-forget wrapper for the webhook, which must never fail a credit over
 * a notification.
 *
 * The money has already moved by the time this runs. A push that cannot be
 * delivered is a worse experience, not a worse outcome, and turning it into an
 * error would put a delivered credit back into Fygaro's retry loop.
 */
export const sendFygaroTopupNotificationBestEffort = async (
  args: Parameters<typeof sendFygaroTopupNotification>[0],
): Promise<void> => {
  const result = await sendFygaroTopupNotification(args)

  if (result instanceof DeviceTokensNotRegisteredNotificationsServiceError) {
    // Stale tokens from a reinstalled or handed-on device. Prune them, exactly
    // as the Bridge deposit path does, so the next notification is not sent
    // into the same void.
    const accountId = checkedToAccountId(args.accountId)
    if (accountId instanceof Error) return

    const account = await AccountsRepository().findById(accountId)
    if (account instanceof Error) return

    await removeDeviceTokens({
      userId: account.kratosUserId,
      deviceTokens: result.tokens,
    })
    return
  }

  if (result instanceof Error) {
    baseLogger.warn(
      { accountId: args.accountId, outcome: args.outcome, error: result },
      "Failed to send Fygaro top-up push notification",
    )
  }
}
