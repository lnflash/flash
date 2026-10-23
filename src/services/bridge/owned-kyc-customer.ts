import { toBridgeCustomerId } from "@domain/primitives/bridge"

import { BridgeError } from "./errors"

/** A single provider resource identifier, never an encoded URL or dot segment. */
export const checkedOwnedKycCustomerId = (value: unknown): BridgeCustomerId => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    /[^A-Za-z0-9_-]/.test(value)
  ) {
    throw new BridgeError("Invalid Bridge customer association")
  }
  return toBridgeCustomerId(value)
}
