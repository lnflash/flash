import {
  LikelyUserAlreadyExistError,
  PhoneAlreadyRegisteredError,
  PhoneNotAllowedForRegistrationError,
} from "@domain/authentication/errors"
import {
  KratosHookMessageId,
  kratosHookMessageIdsFromFlow,
} from "@domain/authentication/kratos-hook-messages"

import { RegistrationHookFailedError } from "./errors"

const isStatus400 = (err: unknown): boolean =>
  err instanceof Error && err.message === "Request failed with status code 400"

// Ids the hook answers with when it could not evaluate the sign-up at all:
// malformed hook payload (Kratos' body template and the api disagree), bad
// callback secret, repository failure. None of them says anything about the
// phone, so none may be reported as a phone-policy answer.
const HOOK_FAILURE_IDS: ReadonlySet<number> = new Set([
  KratosHookMessageId.PayloadInvalid,
  KratosHookMessageId.Unauthorized,
  KratosHookMessageId.InternalError,
])

// Kratos answers a self-service registration with 400 for two very different
// reasons: the identifier already exists, or the pre-persist web hook rejected
// the sign-up. The rejected flow carries our own message ids; anything else
// keeps the historical "likely already exists" reading.
export const mapRegistrationFlowRejection = (
  err: unknown,
):
  | PhoneAlreadyRegisteredError
  | PhoneNotAllowedForRegistrationError
  | RegistrationHookFailedError
  | LikelyUserAlreadyExistError
  | null => {
  if (!isStatus400(err)) return null

  const data = (err as { response?: { data?: unknown } }).response?.data
  const ids = kratosHookMessageIdsFromFlow(data)

  if (ids.includes(KratosHookMessageId.PhoneAlreadyRegistered)) {
    return new PhoneAlreadyRegisteredError()
  }

  if (ids.includes(KratosHookMessageId.PhoneNotAllowed)) {
    return new PhoneNotAllowedForRegistrationError()
  }

  const failureId = ids.find((id) => HOOK_FAILURE_IDS.has(id))
  if (failureId !== undefined) {
    return new RegistrationHookFailedError(`hook message id ${failureId}`)
  }

  return new LikelyUserAlreadyExistError((err as Error).message)
}
