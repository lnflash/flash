import crypto from "crypto"

import { Request, Response, NextFunction } from "express"
import { IbexConfig } from "@config"
import { baseLogger } from "@services/logger"
import { isWeakSecret } from "@utils/weak-secrets"

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

export const authenticate = (req: Request, resp: Response, next: NextFunction) => {
  // Fail closed when the configured secret is missing or a known-public
  // placeholder (e.g. "not-so-secret" from the repo's dev configs) — accepting
  // it would let anyone forge payment webhooks that credit user balances.
  const configured = IbexConfig.webhook.secret
  if (isWeakSecret(configured)) {
    baseLogger.error(
      "IBEX webhook secret is unset or a known placeholder — refusing request",
    )
    return resp.status(503).end("Webhook secret not configured")
  }

  if (!timingSafeStringEqual(req.body.webhookSecret, configured))
    return resp.status(401).end("Invalid secret")
  next()
}
