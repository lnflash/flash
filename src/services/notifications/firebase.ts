import * as admin from "firebase-admin"
import { Messaging } from "firebase-admin/lib/messaging/messaging"
import { GOOGLE_APPLICATION_CREDENTIALS } from "@config"
import { FirebaseMessageError, FirebaseNotAvailable } from "@domain/notifications"
import {
  safeFirebaseCount,
  safeFirebaseMessagingCode,
} from "@domain/notifications/firebase-error-code"
import { baseLogger } from "@services/logger"

let messaging: Messaging | null = null

if (GOOGLE_APPLICATION_CREDENTIALS) {
  try {
    baseLogger.info("Firebase initialization")
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
    })

    messaging = admin.messaging()
    baseLogger.info("Firebase messaging module loaded")
  } catch (err) {
    baseLogger.error(
      { operation: "initialize_push", code: safeFirebaseMessagingCode(err) },
      "Failed to initialize Firebase Admin",
    )
  }
} else {
  baseLogger.warn("GOOGLE_APPLICATION_CREDENTIALS not set")
}

const isDeviceTokenValid = async (
  token: string,
): Promise<boolean | NotificationsServiceError> => {
  if (!messaging) return new FirebaseNotAvailable()
  try {
    await messaging.send(
      {
        token: token,
        notification: {
          title: "Test Message",
          body: "Checking if FCM token is valid",
        },
      },
      true, // dryrun - for token validation purposes only
    )
    return true
  } catch (e: unknown) {
    const code = safeFirebaseMessagingCode(e)
    if (code === "messaging/registration-token-not-registered") {
      baseLogger.warn(
        { operation: "validate_push_token", code },
        "Invalid or expired FCM token",
      )
      return false
    } else {
      baseLogger.error(
        { operation: "validate_push_token", code },
        "Unable to validate push token",
      )
      return new FirebaseMessageError(e)
    }
  }
}

// Failed subscriptions need a retry mechanism
const subscribeToTopics = async (
  tokens: string | string[],
  topics: string[],
): Promise<void> => {
  topics.forEach(async (t) => {
    if (!messaging) {
      baseLogger.error(
        { operation: "subscribe_push_topic" },
        "Firebase messaging module not loaded, skipping topic subscription",
      )
      return new FirebaseNotAvailable()
    }
    try {
      const result = await messaging.subscribeToTopic(tokens, t)
      baseLogger.info(
        {
          operation: "subscribe_push_topic",
          successCount: safeFirebaseCount(
            result.successCount,
            typeof tokens === "string" ? 1 : tokens.length,
          ),
          failureCount: safeFirebaseCount(
            result.failureCount,
            typeof tokens === "string" ? 1 : tokens.length,
          ),
        },
        "Push topic subscription completed",
      )
    } catch (error) {
      // This is intentionally fire-and-forget today. Contain provider errors
      // here so the process-level rejection logger cannot serialize a token.
      baseLogger.error(
        { operation: "subscribe_push_topic", code: safeFirebaseMessagingCode(error) },
        "Push topic subscription failed",
      )
    }
  })
}

export default { isDeviceTokenValid, subscribeToTopics }
export { messaging }
