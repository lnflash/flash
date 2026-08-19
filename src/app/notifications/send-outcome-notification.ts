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
import { PushNotificationsService } from "@services/notifications/push-notifications"

const i18n = getI18nInstance()

/**
 * The shared body behind every "here is how your money movement ended" push
 * (Bridge deposits, Fygaro card top-ups, and whatever comes next).
 *
 * Each of those flows differs only in its i18n key prefix, its `data.type`, and
 * how it formats the amount — the account/user lookup, locale resolution, send,
 * and stale-token pruning are identical. They used to be copied per flow, which
 * meant a fix to token pruning or locale handling had to be made in every copy
 * and whoever made it in one would not know about the others.
 */
export type OutcomeNotificationArgs = {
  accountId: string
  // i18n key prefix: `${phraseBase}.title` and `${phraseBase}.body` must exist
  // in every shipped locale.
  phraseBase: string
  // The `type` the mobile app switches on to route/render the push.
  dataType: string
  // Already display-formatted, interpolated into `${phraseBase}.body` as
  // {{amount}}. Formatting stays with the caller because each flow knows what
  // its number means (gross vs net, which currency).
  amountArg: string
  // Merged into the FCM `data` payload alongside `type`. Keys are conventional
  // across flows: `amount` is MAJOR units ("56.52"), `currency` an ISO code.
  extraData?: Record<string, string>
}

/**
 * Deliberately NOT exported. Every caller of this module is on a money path
 * where the payment has already been captured, so a notification failure must
 * never become the payment's failure — which is what an error-returning variant
 * in reach of a caller eventually becomes. `sendOutcomeNotificationBestEffort`
 * is the module's only entry point; this stays private to it.
 */
const sendOutcomeNotification = async ({
  accountId: accountIdRaw,
  phraseBase,
  dataType,
  amountArg,
  extraData,
}: OutcomeNotificationArgs): Promise<true | ApplicationError> => {
  const accountId = checkedToAccountId(accountIdRaw)
  if (accountId instanceof Error) return accountId

  const account = await AccountsRepository().findById(accountId)
  if (account instanceof Error) return account

  const user = await UsersRepository().findById(account.kratosUserId)
  if (user instanceof Error) return user

  const locale = getLanguageOrDefault(user.language)

  const title = i18n.__({ phrase: `${phraseBase}.title`, locale })
  const body = i18n.__({ phrase: `${phraseBase}.body`, locale }, { amount: amountArg })

  const result = await PushNotificationsService().sendFilteredNotification({
    deviceTokens: user.deviceTokens,
    title,
    body,
    notificationCategory: FlashNotificationCategories.Payments,
    notificationSettings: account.notificationSettings,
    data: {
      type: dataType,
      ...extraData,
    },
  })

  if (result instanceof NotificationsServiceError) return result

  return true
}

/**
 * Fire-and-forget wrapper for callers on a money path, which must never fail a
 * settled payment over a notification.
 *
 * The money has already moved by the time this runs. A push that cannot be
 * delivered is a worse experience, not a worse outcome, and turning it into an
 * error would put a delivered credit back into the provider's retry loop.
 */
export const sendOutcomeNotificationBestEffort = async ({
  logMessage,
  logContext,
  ...args
}: OutcomeNotificationArgs & {
  logMessage: string
  logContext: Record<string, unknown>
}): Promise<void> => {
  try {
    await sendOutcomeNotificationOrPrune({ logMessage, logContext, ...args })
  } catch (error) {
    // "Best effort" has to be a property of THIS function, not of today's
    // callees. Its caller awaits it on the money path and relies on it never
    // throwing — a guarantee that otherwise holds only because every repository
    // in the chain currently returns errors rather than raising them. One
    // future `throw` anywhere below would turn a delivered credit into a 500
    // and hand it back to the provider's retry loop.
    baseLogger.warn({ ...logContext, error }, logMessage)
  }
}

const sendOutcomeNotificationOrPrune = async ({
  logMessage,
  logContext,
  ...args
}: OutcomeNotificationArgs & {
  logMessage: string
  logContext: Record<string, unknown>
}): Promise<void> => {
  const result = await sendOutcomeNotification(args)

  if (result instanceof DeviceTokensNotRegisteredNotificationsServiceError) {
    // Stale tokens from a reinstalled or handed-on device. Prune them so the
    // next notification is not sent into the same void.
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
    baseLogger.warn({ ...logContext, error: result }, logMessage)
  }
}
