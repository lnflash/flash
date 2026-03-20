import { checkedToAccountUuid } from "@domain/accounts"
import { checkedToNotificationCategory, GaloyNotificationCategories } from "@domain/notifications"
import { checkedToDeviceToken } from "@domain/users"
import { AccountsRepository, UsersRepository } from "@services/mongoose"
import { NotificationsService } from "@services/notifications"

export const sendCashoutNotification = async (
    {
        accountId: accountIdRaw,
        title,
        body,
        amount,
        currency,
        notificationCategory,
        deviceTokens
    }: {
        accountId: string,
        title: string,
        body: string,
        amount: number,
        currency: string,
        notificationCategory?: string,
        deviceTokens?: string[]
    }): Promise<true | ApplicationError> => {

    const checkedNotificationCategory = notificationCategory ? checkedToNotificationCategory(notificationCategory) : GaloyNotificationCategories.Payments

    if (checkedNotificationCategory instanceof Error) return checkedNotificationCategory

    const accountId = checkedToAccountUuid(accountIdRaw)
    if (accountId instanceof Error) return accountId

    const accountsRepo = AccountsRepository()
    const account = await accountsRepo.findByUuid(accountId)
    if (account instanceof Error) return account
    const kratosUserId = account.kratosUserId

    let tokens: DeviceToken[] = []
    if (deviceTokens && deviceTokens.length > 0) {
        for (const token of deviceTokens) {
            const checkedToken = await checkedToDeviceToken(token)
            if (checkedToken instanceof Error) return checkedToken
            tokens.push(checkedToken)
        }
    } else {
        const usersRepo = UsersRepository()
        const user = await usersRepo.findById(kratosUserId)
        if (user instanceof Error) return user
        tokens = user.deviceTokens
    }

    const success = await NotificationsService().adminPushNotificationFilteredSend({
        deviceTokens: tokens,
        title,
        body,
        data: { amount: amount.toString(), currency },
        notificationCategory: checkedNotificationCategory,
        notificationSettings: account.notificationSettings,
    })

    return success
}