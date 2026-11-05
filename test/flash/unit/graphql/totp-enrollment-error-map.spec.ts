import {
  DeviceTotpRequiresPhoneUpgradeError,
  TotpEnrollmentUnavailableError,
} from "@domain/authentication/errors"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"

it.each([
  [
    new DeviceTotpRequiresPhoneUpgradeError("private-provider-message"),
    "DEVICE_TOTP_REQUIRES_PHONE_UPGRADE",
    "Verify your phone before setting up an authenticator.",
  ],
  [
    new TotpEnrollmentUnavailableError("private-provider-message"),
    "TOTP_ENROLLMENT_UNAVAILABLE",
    "Authenticator setup is unavailable. Check your account and try again.",
  ],
])(
  "returns a fixed actionable %s payload without logging out a valid session",
  (error, code, message) => {
    const result = mapAndParseErrorForGqlResponse(error as ApplicationError)
    expect(result.code).toBe(code)
    expect(result.message).toBe(message)
    expect(result.code).not.toBe("NOT_AUTHENTICATED")
    expect(result.message).not.toContain("private-provider-message")
  },
)
