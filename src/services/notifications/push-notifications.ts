import * as admin from "firebase-admin"

import {
  DeviceTokensNotRegisteredNotificationsServiceError,
  FirebaseMessageError,
  InvalidDeviceNotificationsServiceError,
  NoDeviceAcceptedPushNotificationsServiceError,
  NotificationChannel,
  NotificationsServiceError,
  NotificationsServiceUnreachableServerError,
  UnknownNotificationsServiceError,
  shouldSendNotification,
} from "@domain/notifications"
import { ErrorLevel, parseErrorMessageFromUnknown } from "@domain/shared"
import { baseLogger } from "@services/logger"
import { recordExceptionInCurrentSpan, wrapAsyncToRunInSpan } from "@services/tracing"

import { FirebaseError } from "firebase-admin"
import { Message } from "firebase-admin/lib/messaging/messaging-api"

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
      return new NotificationsServiceError("Firebase messaging module not loaded")
    }

    const batchResp = await messaging.sendEachForMulticast({ tokens, ...message }, false)

    const invalidTokens: DeviceToken[] = []
    // Deduped so a 200-device fleet failing on one bad APNs key reports one
    // code, not two hundred. Carried on the returned error: the per-token warn
    // lines below are keyed by token only, with no account or operator on them.
    const failureCodes = new Set<string>()
    batchResp.responses.forEach((r, idx) => {
      if (!r.success) {
        failureCodes.add(r.error?.code ?? "unknown")
        logger.warn(
          { error: r.error, token: tokens[idx] },
          "Error sending notification to device",
        )
        recordExceptionInCurrentSpan({
          error: new FirebaseMessageError(
            r.error as unknown as FirebaseError,
            tokens[idx],
          ),
          level: ErrorLevel.Warn,
        })
      }
      if (r.error?.code === "messaging/registration-token-not-registered") {
        invalidTokens.push(tokens[idx])
      }
    })

    logger.info(
      {
        successCount: batchResp.successCount,
        failureCount: batchResp.failureCount,
        failureCodes: [...failureCodes],
      },
      "Notification batch response",
    )

    // addAttributesToCurrentSpan({
    //   failureCount: response.failureCount,
    //   successCount: response.successCount,
    // })

    if (invalidTokens.length > 0) {
      return new DeviceTokensNotRegisteredNotificationsServiceError(
        invalidTokens,
        batchResp.successCount,
        [...failureCodes],
      )
    }

    // Tokens can fail for reasons other than being unregistered (expired APNs
    // auth key, sender-id mismatch, quota). Those leave `invalidTokens` empty,
    // so without this check a send where every device failed would report
    // success and nothing would have been delivered.
    if (batchResp.successCount === 0) {
      // Typed, not a bare NotificationsServiceError: it subclasses one, so every
      // existing caller (log-and-continue, bestEffort wrappers) behaves
      // identically, while the admin resolver can tell the operator that the
      // push infrastructure is broken instead of "Unexpected error occurred".
      // This is the expired-APNs-auth-key case: no token is unregistered, so
      // invalidTokens is empty and nothing above catches it.
      return new NoDeviceAcceptedPushNotificationsServiceError(
        "no device accepted the push",
        [...failureCodes],
      )
    }

    return true
  } catch (err) {
    logger.error({ err, tokens, message }, "impossible to send notification")
    const error = handleCommonNotificationErrors(err)
    recordExceptionInCurrentSpan({ error, level: ErrorLevel.Warn })
    return error
  }
}

// Wraps the Firebase messaging service
export const PushNotificationsService = (): IPushNotificationsService => {
  const send = async (message: Message): Promise<string | NotificationsServiceError> => {
    if (!messaging) {
      baseLogger.error("Firebase messaging module not loaded")
      return new NotificationsServiceError("Firebase messaging module not loaded")
    }

    return messaging.send(message)
  }

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

  return { send, sendNotification, sendFilteredNotification }
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
