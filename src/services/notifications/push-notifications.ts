import * as admin from "firebase-admin"

import {
  DeviceTokensNotRegisteredNotificationsServiceError,
  InvalidDeviceNotificationsServiceError,
  NotificationChannel,
  NotificationsServiceError,
  NotificationsServiceUnreachableServerError,
  UnknownNotificationsServiceError,
  shouldSendNotification,
} from "@domain/notifications"
import { ErrorLevel, parseErrorMessageFromUnknown } from "@domain/shared"
import { baseLogger } from "@services/logger"
import {
  addAttributesToCurrentSpan,
  recordExceptionInCurrentSpan,
  wrapAsyncToRunInSpan,
} from "@services/tracing"
import { messaging } from "./firebase"

const logger = baseLogger.child({ module: "notifications" })

type MessagingPayload = admin.messaging.MessagingPayload
type NotificationMessagePayload = admin.messaging.NotificationMessagePayload

const sendToDevice = async (
  tokens: DeviceToken[],
  message: MessagingPayload & {
    notification: NotificationMessagePayload
  },
) => {
  logger.info({ tokens, ...message })
  try {
    if (!messaging) {
      baseLogger.error("Firebase messaging module not loaded")
      // FIXME: should return an error?
      return true
    }


    // data?: {  COMES FROM MessagingPayload 
    //     [key: string]: string;
    // };
    // notification?: Notification;
    // android?: AndroidConfig;
    // webpush?: WebpushConfig;
    // apns?: ApnsConfig;
    // fcmOptions?: FcmOptions;
    const response = await messaging.sendEachForMulticast({ tokens, ...message }, false)

    const invalidTokens: DeviceToken[] = []
    response.responses.forEach((item, index: number) => {
      if (
        response.responses.length === tokens.length &&
        item?.error?.code === "messaging/registration-token-not-registered"
      ) {
        invalidTokens.push(tokens[index])
      }
      if (item?.error?.message) {
        recordExceptionInCurrentSpan({
          error: new InvalidDeviceNotificationsServiceError(item.error.message),
          level: ErrorLevel.Warn,
          attributes: {
            code: item?.error?.code,  
            token: tokens[index],  
          },
        })
      }
    })

    addAttributesToCurrentSpan({
      failureCount: response.failureCount,
      successCount: response.successCount,
    })

    if (invalidTokens.length > 0) {
      return new DeviceTokensNotRegisteredNotificationsServiceError(invalidTokens)
    }

    return true
  } catch (err) {
    logger.error({ err, tokens, message }, "impossible to send notification")
    const error = handleCommonNotificationErrors(err)
    recordExceptionInCurrentSpan({ error, level: ErrorLevel.Warn })
    return error
  }
}

export const PushNotificationsService = (): IPushNotificationsService => {
  const sendNotification = async ({
    deviceTokens,
    title,
    body,
    data,
  }: SendPushNotificationArgs): Promise<true | NotificationsServiceError> => {
    const message: MessagingPayload & { notification: NotificationMessagePayload } = {
      // if we set notification, it will appears on both background and quit stage for iOS.
      // if we don't set notification, this will appear for background but not quit stage
      // we may be able to use data only, but this should be implemented first:
      // https://rnfirebase.io/messaging/usage#background-application-state
      notification: { title, body },
      data: data || {},
    }

    const tokens = deviceTokens.filter((token) => token.length === 163)
    if (tokens.length <= 0) {
      logger.info({ message, tokens }, "no token. skipping notification")
      return new InvalidDeviceNotificationsServiceError()
    }

    return wrapAsyncToRunInSpan({
      namespace: "app.notifications",
      fnName: "sendToDevice",
      fn: () => sendToDevice(tokens, message),
    })()
  }

  const sendFilteredNotification = async (args: SendFilteredPushNotificationArgs) => {
    const { notificationSettings, notificationCategory, data, ...sendNotificationArgs } =
      args

    if (
      !shouldSendNotification({
        notificationCategory,
        notificationSettings,
        notificationChannel: NotificationChannel.Push,
      })
    ) {
      return {
        status: SendFilteredPushNotificationStatus.Filtered,
      }
    }

    const result = await sendNotification({
      ...sendNotificationArgs,
      data: {
        ...data,
        NotificationCategory: notificationCategory,
      },
    })

    if (result instanceof NotificationsServiceError) {
      return result
    }

    return {
      status: SendFilteredPushNotificationStatus.Sent,
    }
  }

  return { sendNotification, sendFilteredNotification }
}

export const handleCommonNotificationErrors = (err: Error | string | unknown) => {
  const errMsg = parseErrorMessageFromUnknown(err)

  const match = (knownErrDetail: RegExp): boolean => knownErrDetail.test(errMsg)

  switch (true) {
    case match(KnownNotificationErrorMessages.GoogleBadGatewayError):
    case match(KnownNotificationErrorMessages.GoogleInternalServerError):
      return new NotificationsServiceUnreachableServerError(errMsg)

    default:
      return new UnknownNotificationsServiceError(errMsg)
  }
}

export const KnownNotificationErrorMessages = {
  GoogleBadGatewayError: /Raw server response .* Error 502/,
  GoogleInternalServerError: /Raw server response .* Error 500/,
} as const

export const SendFilteredPushNotificationStatus = {
  Sent: "Sent",
  Filtered: "Filtered",
} as const
