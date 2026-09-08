import crypto from "crypto"

import { Request, Response, NextFunction } from "express"
import { IbexConfig } from "@config"
import { baseLogger } from "@services/logger"
import { isWeakSecret, MIN_SECRET_LENGTH } from "@utils/weak-secrets"

const timingSafeStringEqual = (actual: unknown, expected: unknown): boolean => {
  if (typeof actual !== "string" || typeof expected !== "string" || expected === "") {
    return false
  }

  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expected)

  return (
    actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  )
}

// Named once so the boot warning and the per-request error say the same thing.
// The message must name the length floor as well as the placeholder set: a
// configured-but-short secret is refused too, and an operator told only about
// "placeholders" greps for one they do not have.
const unusableSecretMessage =
  `IBEX webhook secret is unset, shorter than ${MIN_SECRET_LENGTH} chars, or a ` +
  `known-public placeholder — refusing request`

// Called at boot (see the webhook server's start()) so a secret that will 503
// every /receive/* call — settled invoices and on-chain receives silently stop
// crediting balances, while /health keeps answering 200 — is visible in the
// startup log instead of only per rejected request.
export const warnIfIbexWebhookSecretWeak = (): void => {
  if (!isWeakSecret(IbexConfig.webhook.secret)) return
  baseLogger.warn(
    `IBEX webhook secret unusable (IbexConfig.webhook.secret is unset, shorter ` +
      `than ${MIN_SECRET_LENGTH} chars, or a known-public placeholder) — every ` +
      `/receive/* and /pay/* webhook will be rejected with 503`,
  )
}

export const authenticate = (req: Request, resp: Response, next: NextFunction) => {
  // Fail closed when the configured secret is missing or a known-public
  // placeholder (e.g. "not-so-secret" from the repo's dev configs) — accepting
  // it would let anyone forge payment webhooks that credit user balances.
  const configured = IbexConfig.webhook.secret
  if (isWeakSecret(configured)) {
    baseLogger.error(unusableSecretMessage)
    return resp.status(503).end("Webhook secret not configured")
  }

  if (!timingSafeStringEqual(req.body.webhookSecret, configured))
    return resp.status(401).end("Invalid secret")
  next()
}
