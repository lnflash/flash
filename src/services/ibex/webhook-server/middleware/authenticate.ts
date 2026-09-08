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

// Named once so the boot guard's WeakSecretError and the per-request error
// point operators at the same config key.
export const IBEX_WEBHOOK_SECRET_NAME = "IBEX webhook secret (ibex.webhook.secret)"

// Named once so the boot warning and the per-request error say the same thing.
// The message must name the length floor as well as the placeholder set: a
// configured-but-short secret is refused too, and an operator told only about
// "placeholders" greps for one they do not have.
const unusableSecretMessage =
  `IBEX webhook secret is unset, shorter than ${MIN_SECRET_LENGTH} chars, or a ` +
  `known-public placeholder — refusing request`

// Every secret a delivery may legitimately carry: the one currently registered
// with IBEX, plus the rotation window in `previousSecrets`.
//
// IBEX binds the secret PER OBJECT at creation time (see the client's
// addInvoice / generateBitcoinAddress / lnurlp calls), and two of those objects
// outlive any rotation: a wallet's lnurlp is created once at wallet creation
// and stored on the wallet forever, and an on-chain deposit address stays valid
// after being handed to a user. Rotating `secret` alone therefore leaves every
// pre-existing Lightning address and deposit address delivering with the OLD
// value — 401 here, and settled payments silently stop crediting balances while
// /health stays green. Configuring the outgoing value in `previousSecrets`
// keeps those deliveries authenticating until the objects are re-registered.
//
// Weak entries are dropped rather than accepted: a publicly known value in the
// rotation list is a forged-webhook path, which is what this middleware exists
// to close. The boot guard warns about each one it drops.
export const ibexWebhookAcceptedSecrets = (): string[] => {
  const configured = [
    IbexConfig.webhook.secret,
    ...(IbexConfig.webhook.previousSecrets ?? []),
  ]
  return configured.filter((secret): secret is string => !isWeakSecret(secret))
}

// Called at boot (see the webhook server's start(), which asserts on the
// registration secret first) so a rotation entry that will never authenticate
// anything is visible in the startup log rather than surfacing as 401s on
// pre-rotation invoices hours later.
export const warnIfIbexWebhookRotationSecretsUnusable = (): void => {
  const unusable = (IbexConfig.webhook.previousSecrets ?? []).filter((secret) =>
    isWeakSecret(secret),
  )
  if (unusable.length === 0) return
  baseLogger.warn(
    `${unusable.length} of ${IbexConfig.webhook.previousSecrets?.length} ` +
      `ibex.webhook.previousSecrets entries are unusable (unset, shorter than ` +
      `${MIN_SECRET_LENGTH} chars, or a known-public placeholder) and will NOT be ` +
      `accepted — webhooks for objects registered with them are rejected with 401`,
  )
}

export const authenticate = (req: Request, resp: Response, next: NextFunction) => {
  // Fail closed when nothing usable is configured: the secret is missing, or
  // every configured value is a known-public placeholder (e.g. the repo's own
  // dev config) or under the length floor. Accepting one would let anyone forge
  // payment webhooks that credit user balances.
  const accepted = ibexWebhookAcceptedSecrets()
  if (isWeakSecret(IbexConfig.webhook.secret) || accepted.length === 0) {
    baseLogger.error(unusableSecretMessage)
    return resp.status(503).end("Webhook secret not configured")
  }

  // No short-circuit: every accepted value is compared, so the number of
  // comparisons does not depend on which one matched.
  let matched = false
  for (const secret of accepted) {
    if (timingSafeStringEqual(req.body.webhookSecret, secret)) matched = true
  }

  if (!matched) return resp.status(401).end("Invalid secret")
  next()
}
