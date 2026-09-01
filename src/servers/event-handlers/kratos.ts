import cors from "cors"
import express from "express"

import { wrapAsyncToRunInSpan } from "@services/tracing"
import { baseLogger } from "@services/logger"
import { maskPhone } from "@services/alerts/ops-events"

import { Authentication } from "@app"

import {
  PhoneAlreadyExistsError,
  RegistrationPayloadValidationError,
  SecretForAuthNCallbackError,
} from "@domain/authentication/errors"
import {
  KratosHookMessageId,
  kratosHookRejection,
} from "@domain/authentication/kratos-hook-messages"
import { InvalidPhoneNumber } from "@domain/errors"
import {
  InvalidCarrierForPhoneMetadataError,
  InvalidCarrierTypeForPhoneMetadataError,
  InvalidCountryCodeForPhoneMetadataError,
  PhoneMetadataValidationError,
} from "@domain/users/errors"

const errorResponseMessages: { [key: string]: string } = {
  MissingSecretForAuthNCallbackError: "missing authorization header",
  InvalidSecretForAuthNCallbackError: "incorrect authorization header",
  MissingRegistrationPayloadPropertiesError: "missing inputs",
  UnsupportedSchemaTypeError: "unsupported schema_id",
  InvalidUserId: "invalid userId",
  InvalidPhoneNumber: "invalid phone",
}

const kratosCallback = express.Router({ caseSensitive: true })

kratosCallback.use(cors({ origin: true, credentials: true }))
kratosCallback.use(express.json())

// Pre-persist hook (Kratos web_hook with `response.parse: true`). Runs before
// the identity is written, so a 4xx here aborts the sign-up with nothing
// persisted. Kratos decodes the body of every non-2xx answer as the `messages`
// shape and a 200 as JSON, so this route never answers plain text: a body it
// cannot parse turns into an opaque "webhook failed" for the user.
//
// Validation only — the account is created by /registration below, after the
// identity exists. `identity_id` arrives as the nil uuid and is ignored.
kratosCallback.post(
  "/preregistration",
  wrapAsyncToRunInSpan({
    namespace: "preregistration",
    fn: async (req: express.Request, res: express.Response) => {
      const secret = req.headers.authorization
      const body = req.body ?? {}
      const phone = typeof body.phone === "string" ? maskPhone(body.phone) : undefined

      const result = await Authentication.validatePreRegistrationPayload({
        secret,
        body,
      })

      if (result instanceof Error) {
        switch (true) {
          case result instanceof SecretForAuthNCallbackError:
            baseLogger.error({ err: result.name }, "preregistration: bad callback secret")
            res.status(401).json(kratosHookRejection(KratosHookMessageId.Unauthorized))
            return

          case result instanceof PhoneAlreadyExistsError:
            baseLogger.warn({ phone, rejection: result.name }, "preregistration rejected")
            res
              .status(400)
              .json(kratosHookRejection(KratosHookMessageId.PhoneAlreadyRegistered))
            return

          case result instanceof InvalidPhoneNumber:
          case result instanceof PhoneMetadataValidationError:
          case result instanceof InvalidCarrierForPhoneMetadataError:
          case result instanceof InvalidCarrierTypeForPhoneMetadataError:
          case result instanceof InvalidCountryCodeForPhoneMetadataError:
            baseLogger.warn({ phone, rejection: result.name }, "preregistration rejected")
            res.status(400).json(kratosHookRejection(KratosHookMessageId.PhoneNotAllowed))
            return

          case result instanceof RegistrationPayloadValidationError:
            baseLogger.warn(
              { phone, rejection: result.name, schemaId: body.schema_id },
              "preregistration rejected",
            )
            res.status(400).json(kratosHookRejection(KratosHookMessageId.PayloadInvalid))
            return

          default:
            baseLogger.error(
              { err: result, phone },
              "preregistration: unexpected error, sign-up aborted",
            )
            res.status(500).json(kratosHookRejection(KratosHookMessageId.InternalError))
            return
        }
      }

      res.status(200).json({})
    },
  }),
)

// Post-persist hook (`response.parse: false`): the identity is already
// committed when this runs. Creates the account and wallets.
kratosCallback.post(
  "/registration",
  wrapAsyncToRunInSpan({
    namespace: "registration",
    fn: async (req: express.Request, res: express.Response) => {
      const secret = req.headers.authorization
      const body = req.body

      const account = await Authentication.createAccountFromRegistrationPayload({
        secret,
        body,
      })
      if (account instanceof Error) {
        const message = errorResponseMessages[account.name] || "unknown error"
        switch (true) {
          case account instanceof SecretForAuthNCallbackError:
            baseLogger.error(message)
            res.status(401).send(message)
            return

          case account instanceof RegistrationPayloadValidationError:
            baseLogger.error(body, message)
            res.status(400).send(message)
            return

          default:
            baseLogger.error(
              { account, phone: body.phone },
              `error createAccountWithPhoneIdentifier`,
            )
            res.status(500).send(`error createAccountWithPhoneIdentifier: ${account}`)
            return
        }
      }

      res.status(200).send("ok\n")
    },
  }),
)

export default kratosCallback
