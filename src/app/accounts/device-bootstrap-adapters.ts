import { randomUUID } from "crypto"

import { Types } from "mongoose"

import type { DeviceBootstrapDependencies } from "@domain/accounts/device-bootstrap"
import { DeviceBootstrapError } from "@domain/authentication/device-bootstrap-error"
import { USDAmount, USDTAmount } from "@domain/shared"
import { DeviceBootstrapRepository } from "@services/mongoose/device-bootstrap"
import { readDeviceBootstrapIdentity } from "@services/kratos/device-bootstrap-identity"
import Ibex from "@services/ibex/client"
import { LockService } from "@services/lock"

/** Provider creation is deliberately separate from WalletsRepository.persistNew:
 * the durable intent and returned ID must bracket the external side effect. */
export const deviceBootstrapDependencies = (): DeviceBootstrapDependencies => ({
  store: DeviceBootstrapRepository(),
  identity: readDeviceBootstrapIdentity,
  newAccountId: () => new Types.ObjectId().toString(),
  newAttemptId: randomUUID,
  currencyId: (currency) =>
    currency === "USD" ? USDAmount.currencyId : USDTAmount.currencyId,
  createProviderAccount: async (accountId, currency) => {
    const result = await Ibex.createAccount(
      accountId,
      currency === "USD" ? USDAmount.currencyId : USDTAmount.currencyId,
    )
    if (result instanceof Error)
      throw new DeviceBootstrapError("DEVICE_BOOTSTRAP_SUPPORT_REQUIRED")
    return result
  },
  withAccountLock: async (accountId, work) => {
    // The real lock adapter converts thrown callback errors. Preserve our safe
    // machine classification inside its callback rather than leaking an error
    // object to that converter or downgrading support-required to retryable.
    const result = await LockService().lockAccountId(
      accountId as AccountId,
      async (signal) => {
        try {
          return { ok: true as const, value: await work(() => signal.aborted) }
        } catch (error) {
          return {
            ok: false as const,
            error:
              error instanceof DeviceBootstrapError
                ? error
                : new DeviceBootstrapError("DEVICE_BOOTSTRAP_RETRY_REQUIRED"),
          }
        }
      },
    )
    if (result instanceof Error)
      throw new DeviceBootstrapError("DEVICE_BOOTSTRAP_RETRY_REQUIRED")
    if (!result.ok) throw result.error
    return result.value
  },
})
