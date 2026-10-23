import { createHash } from "crypto"

import { CreateIdentityBody } from "@ory/client"

import { wrapAsyncFunctionsToRunInSpan } from "@services/tracing"

import { isAxiosError } from "axios"

import {
  InvalidIdentitySessionKratosError,
  KratosError,
  UnknownKratosError,
} from "./errors"
import { kratosAdmin, kratosPublic } from "./private"
import { AuthWithPhonePasswordlessService } from "./auth-phone-no-password"

export const AuthWithUsernamePasswordDeviceIdService =
  (): IAuthWithUsernamePasswordDeviceIdService => {
    const createIdentityWithSession = async ({
      username,
      password,
    }: {
      username: IdentityUsername
      password: IdentityPassword
    }): Promise<CreateIdentityWithSessionResult | KratosError> => {
      let newEntity = true
      const traits = { username }
      const method = "password"
      const identifier = username

      try {
        const createIdentityBody: CreateIdentityBody = {
          credentials: { password: { config: { password } } },
          state: "active",
          traits,
          schema_id: "username_password_deviceid_v0",
          metadata_admin: {
            deviceBootstrap: {
              version: 1,
              deviceIdHash: createHash("sha256").update(username).digest("hex"),
            },
          },
        }

        await kratosAdmin.createIdentity({ createIdentityBody })
      } catch (err) {
        // we continue if there is 409/Conflit,
        // because it means the identity already exists
        if (!isAxiosError(err) || err.response?.status !== 409) {
          return new UnknownKratosError("Unable to create a device identity")
        }

        newEntity = false
      }

      try {
        const flow = await kratosPublic.createNativeLoginFlow()
        const result = await kratosPublic.updateLoginFlow({
          flow: flow.data.id,
          updateLoginFlowBody: {
            identifier,
            method,
            password,
          },
        })
        const authToken = result.data.session_token as AuthToken

        const identity = result.data.session.identity
        if (
          !identity ||
          result.data.session.active !== true ||
          identity.state !== "active" ||
          identity.schema_id !== "username_password_deviceid_v0" ||
          identity.traits?.username !== username ||
          typeof identity.id !== "string" ||
          !identity.id ||
          typeof authToken !== "string" ||
          !authToken ||
          authToken.length > 16_384
        ) {
          return new InvalidIdentitySessionKratosError()
        }

        // note: this only works when whoami: required_aal = aal1
        const kratosUserId = identity.id as UserId

        return { authToken, kratosUserId, newEntity }
      } catch {
        return new UnknownKratosError("Unable to authenticate the device identity")
      }
    }

    const upgradeToPhoneSchema = async ({
      phone,
      userId,
    }: {
      phone: PhoneNumber
      userId: UserId
    }): Promise<true | KratosError> => {
      const authService = AuthWithPhonePasswordlessService()
      const kratosResult = await authService.updateIdentityFromDeviceAccount({
        phone,
        userId,
      })
      if (kratosResult instanceof Error) return kratosResult
      return true
    }

    return wrapAsyncFunctionsToRunInSpan({
      namespace: "services.kratos.auth-username-password-deviceid",
      fns: {
        createIdentityWithSession,
        upgradeToPhoneSchema,
      },
    })
  }
