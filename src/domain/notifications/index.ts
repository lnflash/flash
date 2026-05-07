import { InvalidPushNotificationSettingError as InvalidNotificationSettingsError } from "./errors"
import { getDefaultFCMTopics } from "@config"

export * from "./errors"

export const NotificationType = {
  IntraLedgerReceipt: "intra_ledger_receipt",
  IntraLedgerPayment: "intra_ledger_payment",
  OnchainReceipt: "onchain_receipt",
  OnchainReceiptPending: "onchain_receipt_pending",
  OnchainPayment: "onchain_payment",
  LnInvoicePaid: "paid-invoice",
} as const

export const NotificationChannel = {
  Push: "push",
} as const

export const FlashNotificationCategories = {
  Payments: "Payments" as NotificationCategory,
  Balance: "Balance" as NotificationCategory,
  AdminPushNotification: "AdminPushNotification" as NotificationCategory,
  Cashout: "Cashout" as NotificationCategory
} as const

export const checkedToNotificationCategory = (
  notificationCategory: string,
): NotificationCategory | ValidationError => {

  const validNotificationCategories = Object.values(FlashNotificationCategories)
  if (!validNotificationCategories.includes(notificationCategory as NotificationCategory)) {
    return new InvalidNotificationSettingsError("Invalid notification category")
  }

  return notificationCategory as NotificationCategory
}

export const enableNotificationChannel = ({
  notificationSettings,
  notificationChannel,
}: {
  notificationSettings: NotificationSettings
  notificationChannel: NotificationChannel
}): NotificationSettings => {
  return setNotificationChannelIsEnabled({
    notificationSettings,
    notificationChannel,
    enabled: true,
  })
}

export const disableNotificationChannel = ({
  notificationSettings,
  notificationChannel,
}: {
  notificationSettings: NotificationSettings
  notificationChannel: NotificationChannel
}): NotificationSettings => {
  return setNotificationChannelIsEnabled({
    notificationSettings,
    notificationChannel,
    enabled: false,
  })
}

const setNotificationChannelIsEnabled = ({
  notificationSettings,
  notificationChannel,
  enabled,
}: {
  notificationSettings: NotificationSettings
  notificationChannel: NotificationChannel
  enabled: boolean
}): NotificationSettings => {
  const notificationChannelSettings = notificationSettings[notificationChannel]
  const enabledChanged = notificationChannelSettings.enabled !== enabled

  const newNotificationSettings = {
    enabled,
    disabledCategories: enabledChanged
      ? []
      : notificationChannelSettings.disabledCategories,
  }

  return {
    ...notificationSettings,
    [notificationChannel]: newNotificationSettings,
  }
}

export const enableNotificationCategory = ({
  notificationSettings,
  notificationChannel,
  notificationCategory,
}: {
  notificationSettings: NotificationSettings
  notificationChannel?: NotificationChannel
  notificationCategory: NotificationCategory
}): NotificationSettings => {
  const notificationChannelsToUpdate: NotificationChannel[] = notificationChannel
    ? [notificationChannel]
    : Object.values(NotificationChannel)

  let newNotificationSettings = notificationSettings

  for (const notificationChannel of notificationChannelsToUpdate) {
    const notificationChannelSettings = notificationSettings[notificationChannel]
    const disabledCategories = notificationChannelSettings.disabledCategories

    const newNotificationChannelSettings = {
      enabled: notificationChannelSettings.enabled,
      disabledCategories: disabledCategories.filter(
        (category) => category !== notificationCategory,
      ),
    }

    newNotificationSettings = {
      ...notificationSettings,
      [notificationChannel]: newNotificationChannelSettings,
    }
  }

  return newNotificationSettings
}

export const disableNotificationCategory = ({
  notificationSettings,
  notificationChannel,
  notificationCategory,
}: {
  notificationSettings: NotificationSettings
  notificationChannel?: NotificationChannel
  notificationCategory: NotificationCategory
}): NotificationSettings => {
  const notificationChannelsToUpdate: NotificationChannel[] = notificationChannel
    ? [notificationChannel]
    : Object.values(NotificationChannel)

  let newNotificationSettings = notificationSettings

  for (const notificationChannel of notificationChannelsToUpdate) {
    const notificationChannelSettings = notificationSettings[notificationChannel]
    const disabledCategories = notificationChannelSettings.disabledCategories
    disabledCategories.push(notificationCategory)
    const uniqueDisabledCategories = [...new Set(disabledCategories)]

    const newNotificationChannelSettings = {
      enabled: notificationChannelSettings.enabled,
      disabledCategories: uniqueDisabledCategories,
    }

    newNotificationSettings = {
      ...notificationSettings,
      [notificationChannel]: newNotificationChannelSettings,
    }
  }

  return newNotificationSettings
}

export const shouldSendNotification = ({
  notificationChannel,
  notificationSettings,
  notificationCategory,
}: {
  notificationChannel: NotificationChannel
  notificationSettings: NotificationSettings
  notificationCategory: NotificationCategory
}): boolean => {
  const channelNotificationSettings = notificationSettings[notificationChannel]

  if (channelNotificationSettings.enabled) {
    return !channelNotificationSettings.disabledCategories.includes(notificationCategory)
  }

  return false
}

export const checkedToNotificationTopic = (
  t: string,
): NotificationTopic | ValidationError => {
  const topics = getDefaultFCMTopics()
  if (!topics.includes(t)) {
    return new InvalidNotificationSettingsError(
      `Invalid topic. Must be one of: ${topics.join(", ")}`,
    )
  }
  return t as unknown as NotificationTopic
}
