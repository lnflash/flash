import * as admin from "firebase-admin"
import { Messaging } from "firebase-admin/lib/messaging/messaging"
import { GOOGLE_APPLICATION_CREDENTIALS } from "@config"
import { FirebaseMessageError, FirebaseNotAvailable } from "@domain/notifications"
import { baseLogger } from "@services/logger"


let messaging: Messaging | null  = null

if (GOOGLE_APPLICATION_CREDENTIALS) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  })

  messaging = admin.messaging()
}

const isDeviceTokenValid = async (token: string): Promise<boolean | NotificationsServiceError> => {
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
    );
    return true
  } catch (e: any) {
    if (e.code === "messaging/registration-token-not-registered") {
      baseLogger.warn(`Invalid or expired FCM token: ${token}`);
      return false
    } else {
      baseLogger.error(`Error checking device token: ${e.message}`);
      return new FirebaseMessageError(e, token as DeviceToken)
    }
  }
}

export default { isDeviceTokenValid }
export { messaging } 