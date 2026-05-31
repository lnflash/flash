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

const formatWithdrawalAmount = (amount: string, currency: string): string =>
  `${amount} ${currency.toUpperCase()}`

export type BridgeWithdrawalNotificationOutcome = "completed" | "failed"

export const sendBridgeWithdrawalNotification = async ({
  accountId: accountIdRaw,
  amount,
  currency,
  outcome,
  failureReason,
}: {
  accountId: string
  amount: string
  currency: string
  outcome: BridgeWithdrawalNotificationOutcome
  failureReason?: string
}): Promise<true | ApplicationError> => {
  const accountId = checkedToAccountId(accountIdRaw)
  if (accountId instanceof Error) return accountId

  const account = await AccountsRepository().findById(accountId)
  if (account instanceof Error) return account

  const user = await UsersRepository().findById(account.kratosUserId)
  if (user instanceof Error) return user

  const locale = getLanguageOrDefault(user.language)
  const formattedAmount = formatWithdrawalAmount(amount, currency)
  const phraseBase = `notification.bridgeWithdrawal.${outcome}`

  const title = i18n.__({ phrase: `${phraseBase}.title`, locale })
  const bodyPhrase =
    outcome === "failed" && failureReason
      ? `${phraseBase}.bodyWithReason`
      : `${phraseBase}.body`
  const body = i18n.__(
    { phrase: bodyPhrase, locale },
    {
      amount: formattedAmount,
      reason: failureReason ?? "",
    },
  )

  const result = await PushNotificationsService().sendFilteredNotification({
    deviceTokens: user.deviceTokens,
    title,
    body,
    notificationCategory: FlashNotificationCategories.Cashout,
    notificationSettings: account.notificationSettings,
    data: {
      type: `bridge_withdrawal_${outcome}`,
      amount,
      currency: currency == "usdt" ? "USD" : currency.toUpperCase(),
      ...(failureReason ? { failureReason } : {}),
    },
  })

  if (result instanceof NotificationsServiceError) return result

  if (result.status === SendFilteredPushNotificationStatus.Filtered) {
    return true
  }

  return true
}

export const sendBridgeWithdrawalNotificationBestEffort = async (
  args: Parameters<typeof sendBridgeWithdrawalNotification>[0],
): Promise<void> => {
  const result = await sendBridgeWithdrawalNotification(args)

  if (result instanceof DeviceTokensNotRegisteredNotificationsServiceError) {
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
      "Failed to send Bridge withdrawal push notification",
    )
  }
}
