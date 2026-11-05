import { AuthenticationError } from "./errors"

export type DeviceBootstrapCode =
  | "DEVICE_BOOTSTRAP_SUPPORT_REQUIRED"
  | "DEVICE_BOOTSTRAP_RETRY_REQUIRED"
  | "DEVICE_BOOTSTRAP_OWNER_MISMATCH"
  | "DEVICE_BOOTSTRAP_INCOMPATIBLE_IDENTITY"

const messages: Record<DeviceBootstrapCode, string> = {
  DEVICE_BOOTSTRAP_SUPPORT_REQUIRED:
    "Account setup needs support review before it can continue",
  DEVICE_BOOTSTRAP_RETRY_REQUIRED:
    "Account setup is incomplete; explicitly resume with the same credentials",
  DEVICE_BOOTSTRAP_OWNER_MISMATCH: "Account setup ownership could not be confirmed",
  DEVICE_BOOTSTRAP_INCOMPATIBLE_IDENTITY: "This identity cannot use device-account setup",
}

/** Customer-safe machine classification; never stores credentials or provider prose. */
export class DeviceBootstrapError extends AuthenticationError {
  constructor(readonly code: DeviceBootstrapCode) {
    super(messages[code])
  }
}
