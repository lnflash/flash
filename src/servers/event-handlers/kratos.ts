import cors from "cors"
import express from "express"

import { wrapAsyncToRunInSpan } from "@services/tracing"
import { baseLogger } from "@services/logger"

import { Authentication } from "@app"

import {
  PhoneAlreadyRegisteredError,
  RegistrationPayloadValidationError,
  SecretForAuthNCallbackError,
} from "@domain/authentication/errors"
import {
  KratosHookMessageId,
  kratosHookRejection,
} from "@domain/authentication/kratos-hook-messages"
import { InvalidPhoneNumber } from "@domain/errors"
import { PhoneMetadataValidationError } from "@domain/users/errors"

const errorResponseMessages: { [key: string]: string } = {
  MissingSecretForAuthNCallbackError: "missing authorization header",
  InvalidSecretForAuthNCallbackError: "incorrect authorization header",
  MissingRegistrationPayloadPropertiesError: "missing inputs",
  UnsupportedSchemaTypeError: "unsupported schema_id",
  InvalidUserId: "invalid userId",
  InvalidPhoneNumber: "invalid phone",
}

const recordCallbackFailure = (
  operation: "preregistration" | "registration",
  outcome:
    | "callback_rejected"
    | "phone_registered"
    | "phone_not_allowed"
    | "invalid_payload"
    | "validation_failed"
    | "creation_failed",
  status: 400 | 401 | 500,
  level: "error" | "warn" = "error",
) =>
  baseLogger[level](
    { operation, expectedSchema: "phone_no_password_v0", outcome, status },
    "Kratos callback failed",
  )

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
      let result: Awaited<
        ReturnType<typeof Authentication.validatePreRegistrationPayload>
      >
      try {
        result = await Authentication.validatePreRegistrationPayload({ secret, body })
      } catch {
        recordCallbackFailure("preregistration", "validation_failed", 500)
        res.status(500).json(kratosHookRejection(KratosHookMessageId.InternalError))
        return
      }

      if (result instanceof Error) {
        switch (true) {
          case result instanceof SecretForAuthNCallbackError:
            recordCallbackFailure("preregistration", "callback_rejected", 401)
            res.status(401).json(kratosHookRejection(KratosHookMessageId.Unauthorized))
            return

          case result instanceof PhoneAlreadyRegisteredError:
            recordCallbackFailure("preregistration", "phone_registered", 400, "warn")
            res
              .status(400)
              .json(kratosHookRejection(KratosHookMessageId.PhoneAlreadyRegistered))
            return

          // Every carrier-metadata failure extends PhoneMetadataValidationError.
          case result instanceof InvalidPhoneNumber:
          case result instanceof PhoneMetadataValidationError:
            recordCallbackFailure("preregistration", "phone_not_allowed", 400, "warn")
            res.status(400).json(kratosHookRejection(KratosHookMessageId.PhoneNotAllowed))
            return

          // Not a user error: the body Kratos' template produced does not match
          // what the api expects (missing field, unknown schema_id). Kratos
          // config and the api disagree, so every sign-up is failing.
          case result instanceof RegistrationPayloadValidationError:
            recordCallbackFailure("preregistration", "invalid_payload", 400)
            res.status(400).json(kratosHookRejection(KratosHookMessageId.PayloadInvalid))
            return

          default:
            recordCallbackFailure("preregistration", "validation_failed", 500)
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

      let account: Awaited<
        ReturnType<typeof Authentication.createAccountFromRegistrationPayload>
      >
      try {
        account = await Authentication.createAccountFromRegistrationPayload({
          secret,
          body,
        })
      } catch {
        recordCallbackFailure("registration", "creation_failed", 500)
        res.status(500).send("error createAccountWithPhoneIdentifier")
        return
      }
      if (account instanceof Error) {
        const message = errorResponseMessages[account.name] || "unknown error"
        switch (true) {
          case account instanceof SecretForAuthNCallbackError:
            recordCallbackFailure("registration", "callback_rejected", 401)
            res.status(401).send(message)
            return

          case account instanceof RegistrationPayloadValidationError:
            recordCallbackFailure("registration", "invalid_payload", 400)
            res.status(400).send(message)
            return

          default:
            recordCallbackFailure("registration", "creation_failed", 500)
            res.status(500).send("error createAccountWithPhoneIdentifier")
            return
        }
      }

      res.status(200).send("ok\n")
    },
  }),
)

export default kratosCallback
