import { AuthenticationError } from "@domain/authentication/errors"
import { ErrorLevel } from "@domain/shared"

export class KratosError extends AuthenticationError {}

export class MissingSessionIdError extends KratosError {
  level = ErrorLevel.Critical
}

export class AuthenticationKratosError extends KratosError {}
export class ExtendSessionKratosError extends KratosError {}
export class InvalidIdentitySessionKratosError extends KratosError {}

export class SessionRefreshRequiredError extends KratosError {}

export class EmailAlreadyExistsError extends KratosError {}

export class PhoneAccountAlreadyExistsError extends KratosError {
  level = ErrorLevel.Info
}

export class PhoneAccountAlreadyExistsNeedToSweepFundsError extends KratosError {
  level = ErrorLevel.Info
}

export class PhoneAccountAlreadyExistsCannotUpgradeError extends KratosError {
  level = ErrorLevel.Info
}

export class MissingCreatedAtKratosError extends KratosError {
  level = ErrorLevel.Critical
}

export class MissingExpiredAtKratosError extends KratosError {
  level = ErrorLevel.Critical
}

export class MissingTotpKratosError extends KratosError {
  level = ErrorLevel.Critical
}

export class IncompatibleSchemaUpgradeError extends KratosError {}

export class CodeExpiredKratosError extends KratosError {}

export class UnknownKratosError extends KratosError {
  level = ErrorLevel.Critical
}

// The pre-persist registration hook answered with an id that is never a
// phone-policy answer: the hook payload Kratos sent was malformed, the callback
// secret did not match, or the api could not reach its repository. Kratos
// config and the api disagree, or infra is down — a deploy defect, not a user
// error, so it must never be reported as one.
export class RegistrationHookFailedError extends KratosError {
  level = ErrorLevel.Critical
}
