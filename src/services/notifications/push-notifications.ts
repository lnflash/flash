import * as admin from "firebase-admin"

import {
  DeviceTokensNotRegisteredNotificationsServiceError,
  FirebaseMessageError,
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
import { FirebaseError } from "firebase-admin"

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

    const batchResp = await messaging.sendEachForMulticast({ tokens, ...message }, false)

    const invalidTokens: DeviceToken[] = []
    batchResp.responses
      .forEach((r, idx) => {
        if (!r.success) {
          recordExceptionInCurrentSpan({
            error: new FirebaseMessageError(r.error as unknown as FirebaseError, tokens[idx]),
            level: ErrorLevel.Warn,
          })
        }
        if (r.error?.code === "messaging/registration-token-not-registered") {
          invalidTokens.push(tokens[idx])
        }
      })

    // addAttributesToCurrentSpan({
    //   failureCount: response.failureCount,
    //   successCount: response.successCount,
    // })

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

    if (deviceTokens.length <= 0) {
      logger.info({ message, deviceTokens }, "no token. skipping notification")
      return new InvalidDeviceNotificationsServiceError()
    }

    return wrapAsyncToRunInSpan({
      namespace: "app.notifications",
      fnName: "sendToDevice",
      fn: () => sendToDevice(deviceTokens, message),
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
