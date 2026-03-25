import { getI18nInstance } from "@config"
import {
  NotificationsServiceError,
} from "@domain/notifications"
import { MoneyAmount } from "@domain/shared"
import { AccountsRepository } from "@services/mongoose/accounts"
import { UsersRepository } from "@services/mongoose/users"
import { PushNotificationsService } from "@services/notifications/push-notifications"

const i18n = getI18nInstance();

export const sendCashoutNotification = async (
  accountId: AccountUuid,
  amount: MoneyAmount,
): Promise<true | ApplicationError> => {
  const accountsRepo = AccountsRepository()
  const account = await accountsRepo.findByUuid(accountId)
  if (account instanceof Error) return account
  const kratosUserId = account.kratosUserId

  const usersRepo = UsersRepository()
  const user = await usersRepo.findById(kratosUserId)
  if (user instanceof Error) return user

  const currency = amount.currencyCode

  const result = PushNotificationsService().sendNotification({
    deviceTokens: user.deviceTokens,
    title: i18n.__({ phrase: "notification.cashout.title", locale: "en" }, { currency }),
    body: i18n.__({ phrase: "notification.cashout.body", locale: "en" }, { amount: amount.i18n() }),
    data: { amount: String(amount), currency },
  })
  if (result instanceof NotificationsServiceError) return result

  return result
}
