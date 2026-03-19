type SendPushNotificationArgs = {
  deviceTokens: DeviceToken[]
  title: string
  body: string
  data?: { [key: string]: string }
}

type SendFilteredPushNotificationArgs = {
  deviceTokens: DeviceToken[]
  title: string
  body: string
  data?: { [key: string]: string }
  notificationSettings: NotificationSettings
  notificationCategory: NotificationCategory
}

type SendFilteredPushNotificationStatus =
  (typeof import("./push-notifications").SendFilteredPushNotificationStatus)[keyof typeof import("./push-notifications").SendFilteredPushNotificationStatus]

interface IPushNotificationsService {
  send(message: Message): Promise<string | NotificationsServiceError>

  sendNotification({
    deviceTokens,
    title,
    body,
    data,
  }: SendPushNotificationArgs): Promise<true | NotificationsServiceError>

  sendFilteredNotification(args: SendFilteredPushNotificationArgs): Promise<
    | {
        status: SendFilteredPushNotificationStatus
      }
    | NotificationsServiceError
  >
}
