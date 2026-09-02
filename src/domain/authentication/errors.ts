import { DomainError, ValidationError, ErrorLevel } from "@domain/shared"

export class AuthenticationError extends DomainError {}
export class LikelyNoUserWithThisPhoneExistError extends AuthenticationError {}
export class LikelyUserAlreadyExistError extends AuthenticationError {}

export class AccountHasPositiveBalanceError extends AuthenticationError {}
export class PhoneAlreadyExistsError extends AuthenticationError {}
// The pre-persist registration hook found the phone already bound to a users
// document. Raised on the sign-up path, where the caller has no account and no
// session — so it must not read as "one phone per account"
// (PhoneAlreadyExistsError belongs to the add-phone-to-account flow).
export class PhoneAlreadyRegisteredError extends AuthenticationError {}
// The pre-persist registration hook rejected the phone (unparsable, or its
// carrier metadata failed validation). Distinct from "already registered": the
// user cannot fix it by logging in instead.
export class PhoneNotAllowedForRegistrationError extends AuthenticationError {}

export class EmailCodeInvalidError extends AuthenticationError {}
export class EmailUnverifiedError extends AuthenticationError {}
export class AccountAlreadyHasEmailError extends AuthenticationError {}

export class IdentifierNotFoundError extends AuthenticationError {}

export class EmailValidationSubmittedTooOftenError extends AuthenticationError {}

export class SecretForAuthNCallbackError extends ValidationError {}
export class MissingSecretForAuthNCallbackError extends SecretForAuthNCallbackError {}
export class InvalidSecretForAuthNCallbackError extends SecretForAuthNCallbackError {}

export class RegistrationPayloadValidationError extends ValidationError {}
export class MissingRegistrationPayloadPropertiesError extends RegistrationPayloadValidationError {}
export class UnsupportedSchemaTypeError extends RegistrationPayloadValidationError {}

export class AuthTokenUserIdMismatchError extends AuthenticationError {
  level = ErrorLevel.Critical
}
