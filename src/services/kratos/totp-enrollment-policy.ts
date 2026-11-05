import {
  AuthTokenUserIdMismatchError,
  DeviceTotpRequiresPhoneUpgradeError,
  TotpEnrollmentUnavailableError,
} from "@domain/authentication/errors"

import { kratosAdmin, kratosPublic } from "./private"
import { SchemaIdType } from "./schema"

/** Device Basic login has no AAL2 continuation. Require genuine identifier
 * migration before adding a factor; Mongo phone/level fields are not proof. */
export const authorizeTotpEnrollment = async ({
  authToken,
  userId,
}: {
  authToken: AuthToken
  userId: UserId
}): Promise<true | ApplicationError> => {
  try {
    const { data: session } = await kratosPublic.toSession({ xSessionToken: authToken })
    if (session.identity?.id !== userId) return new AuthTokenUserIdMismatchError()
    if (session.active !== true) return new TotpEnrollmentUnavailableError()

    // Request no credential material. The fresh schema, rather than stale
    // session traits or a caller's account tier, determines the login route.
    const { data: identity } = await kratosAdmin.getIdentity({ id: userId })
    if (identity.id !== userId) return new AuthTokenUserIdMismatchError()
    if (identity.state !== "active") return new TotpEnrollmentUnavailableError()
    switch (identity.schema_id) {
      case SchemaIdType.UsernamePasswordDeviceIdV0:
        return new DeviceTotpRequiresPhoneUpgradeError()
      case SchemaIdType.PhoneNoPasswordV0:
      case SchemaIdType.PhoneEmailNoPasswordV0:
      case SchemaIdType.EmailNoPasswordV0:
        return true
      default:
        return new TotpEnrollmentUnavailableError()
    }
  } catch {
    // Provider failures can contain tokens, traits and HTTP request details.
    return new TotpEnrollmentUnavailableError()
  }
}
