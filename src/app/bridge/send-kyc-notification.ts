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

const PENDING_KYC_STATUSES = new Set<NonNullable<Account["bridgeKycStatus"]>>([
  "open",
  "awaiting_questionnaire",
  "awaiting_ubo",
  "under_review",
  "paused",
])

export type BridgeKycNotificationOutcome =
  | "approved"
  | "rejected"
  | "in_review"
  | "incomplete"
  | "offboarded"

export const isBridgeKycInitiated = (
  status: Account["bridgeKycStatus"],
): status is NonNullable<Account["bridgeKycStatus"]> =>
  status !== undefined && status !== null

export const toBridgeKycNotificationOutcome = (
  status: Account["bridgeKycStatus"],
): BridgeKycNotificationOutcome | null => {
  if (!status || status === "not_started") return null
  if (status === "approved") return "approved"
  if (status === "rejected") return "rejected"
  if (status === "offboarded") return "offboarded"
  if (status === "incomplete") return "incomplete"
  if (PENDING_KYC_STATUSES.has(status)) return "in_review"
  return null
}

const formatRejectionReason = (rejectionReasons: unknown[]): string | undefined => {
  const reasons = rejectionReasons
    .map((reason) => {
      if (typeof reason === "string") return reason
      if (reason && typeof reason === "object" && "reason" in reason) {
        return String((reason as { reason: unknown }).reason)
      }
      return null
    })
    .filter((reason): reason is string => Boolean(reason))

  return reasons.length > 0 ? reasons.join(", ") : undefined
}

export const sendBridgeKycNotification = async ({
  accountId: accountIdRaw,
  outcome,
  kycStatus,
  rejectionReasons = [],
}: {
  accountId: string
  outcome: BridgeKycNotificationOutcome
  kycStatus: NonNullable<Account["bridgeKycStatus"]>
  rejectionReasons?: unknown[]
}): Promise<true | ApplicationError> => {
  const accountId = checkedToAccountId(accountIdRaw)
  if (accountId instanceof Error) return accountId

  const account = await AccountsRepository().findById(accountId)
  if (account instanceof Error) return account

  const user = await UsersRepository().findById(account.kratosUserId)
  if (user instanceof Error) return user

  const locale = getLanguageOrDefault(user.language)
  const phraseBase = `notification.bridgeKyc.${outcome}`
  const rejectionReason = formatRejectionReason(rejectionReasons)

  const title = i18n.__({ phrase: `${phraseBase}.title`, locale })
  const bodyPhrase =
    outcome === "rejected" && rejectionReason
      ? `${phraseBase}.bodyWithReason`
      : `${phraseBase}.body`
  const body = i18n.__(
    { phrase: bodyPhrase, locale },
    { reason: rejectionReason ?? "" },
  )

  const result = await PushNotificationsService().sendFilteredNotification({
    deviceTokens: user.deviceTokens,
    title,
    body,
    notificationCategory: FlashNotificationCategories.Payments,
    notificationSettings: account.notificationSettings,
    data: {
      type: `bridge_kyc_${outcome}`,
      status: kycStatus,
      ...(rejectionReason ? { rejectionReason } : {}),
    },
  })

  if (result instanceof NotificationsServiceError) return result

  if (result.status === SendFilteredPushNotificationStatus.Filtered) {
    return true
  }

  return true
}

export const sendBridgeKycNotificationBestEffort = async (
  args: Parameters<typeof sendBridgeKycNotification>[0],
): Promise<void> => {
  const result = await sendBridgeKycNotification(args)

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
      "Failed to send Bridge KYC push notification",
    )
  }
}
