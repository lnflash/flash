import type { DeviceIdentityProof } from "@domain/accounts/device-bootstrap"
import { DeviceBootstrapError } from "@domain/authentication/device-bootstrap-error"

import { kratosAdmin } from "./private"

/** Fresh exact raw projection: generic AnyIdentity omits the device username. */
export const readDeviceBootstrapIdentity = async (
  userId: string,
): Promise<DeviceIdentityProof> => {
  try {
    const { data } = await kratosAdmin.getIdentity({
      id: userId,
      includeCredential: ["totp"],
    })
    if (
      typeof data.id !== "string" ||
      typeof data.schema_id !== "string" ||
      typeof data.state !== "string"
    ) {
      throw new DeviceBootstrapError("DEVICE_BOOTSTRAP_INCOMPATIBLE_IDENTITY")
    }
    const candidate: unknown =
      data.metadata_admin && typeof data.metadata_admin === "object"
        ? (data.metadata_admin as Record<string, unknown>).deviceBootstrap
        : undefined
    const marker =
      candidate && typeof candidate === "object"
        ? (candidate as Record<string, unknown>)
        : undefined
    if (candidate !== undefined && !marker)
      throw new DeviceBootstrapError("DEVICE_BOOTSTRAP_INCOMPATIBLE_IDENTITY")
    return {
      id: data.id,
      schema: data.schema_id,
      state: data.state,
      username:
        typeof data.traits?.username === "string" ? data.traits.username : undefined,
      totpEnabled: Object.prototype.hasOwnProperty.call(data.credentials ?? {}, "totp"),
      bootstrap: marker
        ? { version: marker.version, deviceIdHash: marker.deviceIdHash }
        : undefined,
    }
  } catch (error) {
    throw error instanceof DeviceBootstrapError
      ? error
      : new DeviceBootstrapError("DEVICE_BOOTSTRAP_RETRY_REQUIRED")
  }
}
