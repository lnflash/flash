import { DomainError, ErrorLevel } from "@domain/shared"

export class NotificationsError extends DomainError {}

export class NotificationsServiceError extends NotificationsError {}
export class InvalidDeviceNotificationsServiceError extends NotificationsServiceError {}
export class DeviceTokensNotRegisteredNotificationsServiceError extends NotificationsServiceError {
  tokens: DeviceToken[]
  constructor(tokens: DeviceToken[], message?: string | unknown | Error) {
    super(message)
    this.tokens = tokens
  }
}
export class NotificationsServiceUnreachableServerError extends NotificationsServiceError {
  level = ErrorLevel.Critical
}
export class UnknownNotificationsServiceError extends NotificationsError {
  level = ErrorLevel.Critical
}

export class InvalidPushNotificationSettingError extends NotificationsError {}

export class FirebaseError extends NotificationsServiceError {}
export class FirebaseNotAvailable extends FirebaseError {}