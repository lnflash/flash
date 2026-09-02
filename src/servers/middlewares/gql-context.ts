import { NextFunction, Request, Response } from "express"

import { UNSECURE_IP_FROM_REQUEST_OBJECT } from "@config"

import { parseCashWalletClientCapabilities } from "@app/cash-wallet-cutover/client-capability"
import { parseIps } from "@domain/accounts-ips"
import { ErrorLevel } from "@domain/shared"
import { AuthenticationError } from "@graphql/error"
import { baseLogger } from "@services/logger"
import {
  ACCOUNT_USERNAME,
  SemanticAttributes,
  addAttributesToCurrentSpanAndPropagate,
  recordExceptionInCurrentSpan,
} from "@services/tracing"

import { sessionPublicContext } from "./session"

// Express 4 does not catch a rejected async middleware. A throw while
// resolving the session used to surface as an unhandled rejection, and Node
// exits the process on those (`--unhandled-rejections=throw` is the default).
// On 2026-09-01 a single Kratos identity whose account write had failed was
// enough to crash every api replica on each request it made
// (CouldNotFindAccountFromKratosIdError out of sessionPublicContext).
//
// Nothing that happens while building the context may take the process down.
// A session that cannot be resolved is answered, not thrown.
//
// Response shape: same constraint as apiKeyRateLimitMiddleware — this /graphql
// server is a federation subgraph behind the Apollo router, which swallows any
// non-2xx subgraph response into an opaque SUBREQUEST_HTTP_ERROR. An
// unauthenticated session is therefore answered as HTTP 200 with a GraphQL
// error carrying a code the client can act on. Anything else is a genuine
// server fault and stays a 500.
export const setGqlContext = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const tokenPayload = req.token

  const ipString = UNSECURE_IP_FROM_REQUEST_OBJECT
    ? req.ip
    : req.headers["x-real-ip"] || req.headers["x-forwarded-for"]

  const ip = parseIps(ipString)

  let gqlContext: Awaited<ReturnType<typeof sessionPublicContext>>
  try {
    gqlContext = await sessionPublicContext({
      tokenPayload,
      ip,
    })
  } catch (err) {
    const kratosUserId = tokenPayload?.sub

    if (err instanceof AuthenticationError) {
      // The session resolved; it just has no usable account. Not a server
      // fault — whatever made it unrepairable was recorded where the repair
      // ran — and an orphan's pollers hit this on every request, so no
      // Critical span here.
      baseLogger.warn({ err, kratosUserId }, "unauthenticated session")
      res.status(200).json({
        data: null,
        errors: [
          {
            message: err.message,
            extensions: { code: err.extensions.code },
          },
        ],
      })
      return
    }

    baseLogger.error({ err, kratosUserId }, "failed to build graphql context")
    recordExceptionInCurrentSpan({
      error: err,
      level: ErrorLevel.Critical,
      attributes: { kratosUserId },
      fallbackMsg: "failed to build graphql context",
    })
    res.status(500).json({ error: "failed to build graphql context" })
    return
  }

  const cashWalletClientCapabilities = parseCashWalletClientCapabilities(req.headers)

  req.gqlContext = {
    ...gqlContext,
    cashWalletClientCapabilities,
  }

  return addAttributesToCurrentSpanAndPropagate(
    {
      "token.iss": tokenPayload?.iss,
      "token.session_id": tokenPayload?.session_id,
      "token.expires_at": tokenPayload?.expires_at,
      [SemanticAttributes.HTTP_CLIENT_IP]: ip,
      [SemanticAttributes.HTTP_USER_AGENT]: req.headers["user-agent"],
      [ACCOUNT_USERNAME]: gqlContext?.domainAccount?.username,
      [SemanticAttributes.ENDUSER_ID]: tokenPayload?.sub,
      "cash_wallet.client_presentation":
        cashWalletClientCapabilities.cashWalletPresentation,
      "cash_wallet.client_usdt_supported": String(
        cashWalletClientCapabilities.hasUsdtCashWalletSupport,
      ),
    },
    next,
  )
}
