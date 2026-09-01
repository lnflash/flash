import {
  LikelyUserAlreadyExistError,
  PhoneAlreadyExistsError,
  PhoneNotAllowedForRegistrationError,
} from "@domain/authentication/errors"
import {
  KratosHookMessageId,
  kratosHookMessageIdsFromFlow,
} from "@domain/authentication/kratos-hook-messages"

const isStatus400 = (err: unknown): boolean =>
  err instanceof Error && err.message === "Request failed with status code 400"

// Kratos answers a self-service registration with 400 for two very different
// reasons: the identifier already exists, or the pre-persist web hook rejected
// the sign-up. The rejected flow carries our own message ids; anything else
// keeps the historical "likely already exists" reading.
export const mapRegistrationFlowRejection = (
  err: unknown,
):
  | PhoneAlreadyExistsError
  | PhoneNotAllowedForRegistrationError
  | LikelyUserAlreadyExistError
  | null => {
  if (!isStatus400(err)) return null

  const data = (err as { response?: { data?: unknown } }).response?.data
  const ids = kratosHookMessageIdsFromFlow(data)

  if (ids.includes(KratosHookMessageId.PhoneAlreadyRegistered)) {
    return new PhoneAlreadyExistsError()
  }

  if (
    ids.includes(KratosHookMessageId.PhoneNotAllowed) ||
    ids.includes(KratosHookMessageId.PayloadInvalid)
  ) {
    return new PhoneNotAllowedForRegistrationError()
  }

  return new LikelyUserAlreadyExistError((err as Error).message)
}
