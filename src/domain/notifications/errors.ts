import { DomainError, ErrorLevel } from "@domain/shared"
import { FirebaseError } from "firebase-admin"

export class NotificationsError extends DomainError {}

export class NotificationsServiceError extends NotificationsError {}
export class InvalidDeviceNotificationsServiceError extends NotificationsServiceError {}
export class DeviceTokensNotRegisteredNotificationsServiceError extends NotificationsServiceError {
  tokens: DeviceToken[]
  // How many devices actually accepted the push. Callers must use this rather
  // than inferring delivery from `tokens.length` — a token can fail for reasons
  // other than being unregistered, so "not stale" does not mean "delivered".
  successCount: number
  // Distinct FCM error codes across every token that failed in this batch, so a
  // caller that ends up reporting a delivery failure can say why.
  failureCodes: string[]
  constructor(
    tokens: DeviceToken[],
    // Defaults to 0 — "nothing is known to have been delivered". The push
    // service always passes the real count; the default only applies to
    // callers that construct this directly, where claiming a delivery we
    // cannot evidence is the dangerous direction to be wrong in.
    successCount = 0,
    failureCodes: string[] = [],
    message?: string | unknown | Error,
  ) {
    super(message)
    this.tokens = tokens
    this.successCount = successCount
    this.failureCodes = failureCodes
  }
}
// Every registered device token was stale and has just been pruned. Distinct
// from InvalidDeviceNotificationsServiceError, which means the user never had
// a device token to begin with.
export class AllDeviceTokensStaleNotificationsServiceError extends NotificationsServiceError {}
// Nothing was delivered, but at least one of the user's tokens was *not* stale.
// The undelivered tokens failed for some other reason (expired APNs auth key,
// sender-id mismatch, quota), so this is a push-infrastructure problem — the
// user cannot fix it by reopening the app, and telling them to is a wasted
// support cycle. Distinct from AllDeviceTokensStaleNotificationsServiceError,
// whose name asserts something stronger than "nothing got through".
export class NoDeviceAcceptedPushNotificationsServiceError extends NotificationsServiceError {
  // The distinct FCM codes Firebase refused with — "messaging/third-party-auth-error"
  // (expired APNs auth key), "messaging/mismatched-credential" (sender-id
  // mismatch), "messaging/quota-exceeded", and so on. This error routes the
  // operator to engineering, so carry the diagnosis with it rather than making
  // eng correlate the per-token warn lines in push-notifications by timestamp.
  failureCodes: string[]
  constructor(message?: string | unknown | Error, failureCodes: string[] = []) {
    super(message)
    this.failureCodes = failureCodes
  }
}
// The recipient turned push off (or disabled this notification category) in the
// app, so the notification was filtered out and never handed to Firebase.
// Nothing was sent — callers must not report this as a successful send.
export class RecipientDisabledNotificationsServiceError extends NotificationsServiceError {}
export class NotificationsServiceUnreachableServerError extends NotificationsServiceError {
  level = ErrorLevel.Critical
}
export class UnknownNotificationsServiceError extends NotificationsError {
  level = ErrorLevel.Critical
}

export class InvalidPushNotificationSettingError extends NotificationsError {}

export class FirebaseNotAvailable extends NotificationsServiceError {}
export class FirebaseMessageError extends NotificationsServiceError {
  constructor(error: FirebaseError, token: DeviceToken) {
    super(
      JSON.stringify({
        ...error,
        token,
      }),
    )
  }
}
