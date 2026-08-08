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

// Referral-flow push notifications (the invite slice of ENG-531):
//  - inviter: their invite was accepted (redeem transition)
//  - inviter: their referral-reward leg paid
//  - invitee: their welcome-reward leg paid
// All senders follow the bridge-KYC pattern: resolve account -> user ->
// deviceTokens, localized phrases, best-effort wrappers that can never throw
// into the calling money/redeem path.

type ReferralNotificationKind = "accepted" | "inviterReward" | "inviteeReward"

const formatAmount = (amountCents: number): string => (amountCents / 100).toFixed(2)

const sendReferralNotification = async ({
  accountId: accountIdRaw,
  kind,
  amountCents,
  inviteeName,
}: {
  accountId: string
  kind: ReferralNotificationKind
  amountCents?: number
  inviteeName?: string
}): Promise<true | ApplicationError> => {
  const accountId = checkedToAccountId(accountIdRaw)
  if (accountId instanceof Error) return accountId

  const account = await AccountsRepository().findById(accountId)
  if (account instanceof Error) return account

  const user = await UsersRepository().findById(account.kratosUserId)
  if (user instanceof Error) return user

  const locale = getLanguageOrDefault(user.language)
  const phraseBase = `notification.referral.${kind}`

  const title = i18n.__({ phrase: `${phraseBase}.title`, locale })
  const bodyPhrase =
    kind === "accepted" && !inviteeName
      ? `${phraseBase}.bodyNoName`
      : `${phraseBase}.body`
  const body = i18n.__(
    { phrase: bodyPhrase, locale },
    {
      name: inviteeName ?? "",
      amount: amountCents !== undefined ? formatAmount(amountCents) : "",
    },
  )

  const result = await PushNotificationsService().sendFilteredNotification({
    deviceTokens: user.deviceTokens,
    title,
    body,
    notificationCategory: FlashNotificationCategories.Payments,
    notificationSettings: account.notificationSettings,
    data: {
      type: `referral_${kind}`,
      ...(amountCents !== undefined ? { amountCents: String(amountCents) } : {}),
    },
  })

  if (result instanceof NotificationsServiceError) return result

  if (result.status === SendFilteredPushNotificationStatus.Filtered) {
    return true
  }

  return true
}

const bestEffort = async (
  args: Parameters<typeof sendReferralNotification>[0],
): Promise<void> => {
  try {
    const result = await sendReferralNotification(args)

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
        { accountId: args.accountId, kind: args.kind, error: result },
        "Failed to send referral push notification",
      )
    }
  } catch (err) {
    // Never let a push failure disturb the redeem or payout path.
    baseLogger.warn(
      { accountId: args.accountId, kind: args.kind, err },
      "Unexpected error sending referral push notification",
    )
  }
}

export const sendInviteAcceptedNotificationBestEffort = async ({
  inviterAccountId,
  inviteeName,
}: {
  inviterAccountId: string
  inviteeName?: string
}): Promise<void> =>
  bestEffort({ accountId: inviterAccountId, kind: "accepted", inviteeName })

export const sendReferralRewardNotificationBestEffort = async ({
  accountId,
  leg,
  amountCents,
}: {
  accountId: string
  leg: "inviter" | "invitee"
  amountCents: number
}): Promise<void> =>
  bestEffort({
    accountId,
    kind: leg === "inviter" ? "inviterReward" : "inviteeReward",
    amountCents,
  })
