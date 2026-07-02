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

const formatDepositAmount = (amount: string, currency: string): string =>
  `${amount} ${currency.toUpperCase()}`

export type BridgeDepositNotificationOutcome = "received" | "processing" | "completed"

export const sendBridgeDepositNotification = async ({
  accountId: accountIdRaw,
  amount,
  currency,
  outcome = "completed",
}: {
  accountId: string
  amount: string
  currency: string
  outcome?: BridgeDepositNotificationOutcome
}): Promise<true | ApplicationError> => {
  const accountId = checkedToAccountId(accountIdRaw)
  if (accountId instanceof Error) return accountId

  const account = await AccountsRepository().findById(accountId)
  if (account instanceof Error) return account

  const user = await UsersRepository().findById(account.kratosUserId)
  if (user instanceof Error) return user

  const locale = getLanguageOrDefault(user.language)
  const formattedAmount = formatDepositAmount(amount, currency)
  const phraseBase = `notification.bridgeDeposit.${outcome}`

  const title = i18n.__({ phrase: `${phraseBase}.title`, locale })
  const body = i18n.__(
    { phrase: `${phraseBase}.body`, locale },
    { amount: formattedAmount },
  )

  const result = await PushNotificationsService().sendFilteredNotification({
    deviceTokens: user.deviceTokens,
    title,
    body,
    notificationCategory: FlashNotificationCategories.Payments,
    notificationSettings: account.notificationSettings,
    data: {
      type: `bridge_deposit_${outcome}`,
      amount,
      currency: currency == "usdt" ? "USD" : currency.toUpperCase(),
    },
  })

  if (result instanceof NotificationsServiceError) return result

  if (result.status === SendFilteredPushNotificationStatus.Filtered) {
    return true
  }

  return true
}

export const sendBridgeDepositNotificationBestEffort = async (
  args: Parameters<typeof sendBridgeDepositNotification>[0],
): Promise<void> => {
  const result = await sendBridgeDepositNotification(args)

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
      { accountId: args.accountId, outcome: args.outcome ?? "completed", error: result },
      "Failed to send Bridge deposit push notification",
    )
  }
}
