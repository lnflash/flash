import { verify, KeyObject } from "crypto"

import { Request, Response, NextFunction } from "express"

import { hubPublicKey, parseHubPublicKey } from "@services/ibex/hub-public-key"
import { baseLogger as logger } from "@services/logger"

// IBEX Hub signs each organization-webhook delivery (ENG-891) with an Ed25519
// key unique to the webhook, the Standard Webhooks way: the signature covers
// "{webhook-id}.{webhook-timestamp}.{raw body}" and arrives as
// "v1a,<base64>". See docs.poweredbyibex.io/webhooks/security.md.

// IBEX's replay window: a delivery signed more than 5 minutes away from now
// is refused.
export const HUB_SIGNATURE_TOLERANCE_SECONDS = 5 * 60

export type HubSignatureCheck =
  | { ok: true }
  | {
      ok: false
      reason:
        | "missing_headers"
        | "bad_timestamp"
        | "stale_timestamp"
        | "no_signature"
        | "bad_signature"
    }

export const checkHubSignature = ({
  webhookId,
  timestamp,
  signatureHeader,
  rawBody,
  publicKey,
  nowSeconds = Math.floor(Date.now() / 1000),
}: {
  webhookId?: string
  timestamp?: string
  signatureHeader?: string
  rawBody: Buffer
  publicKey: KeyObject
  nowSeconds?: number
}): HubSignatureCheck => {
  if (!webhookId || !timestamp || !signatureHeader) {
    return { ok: false, reason: "missing_headers" }
  }
  if (!/^\d+$/.test(timestamp)) return { ok: false, reason: "bad_timestamp" }
  if (Math.abs(nowSeconds - Number(timestamp)) > HUB_SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, reason: "stale_timestamp" }
  }

  // Standard Webhooks allows several space-separated signatures (a key
  // rotation); any v1a one that verifies is enough.
  const signatures = signatureHeader
    .split(" ")
    .filter((part) => part.startsWith("v1a,"))
    .map((part) => Buffer.from(part.slice("v1a,".length), "base64"))
  if (signatures.length === 0) return { ok: false, reason: "no_signature" }

  const signed = Buffer.concat([Buffer.from(`${webhookId}.${timestamp}.`), rawBody])
  const valid = signatures.some((signature) => {
    try {
      return verify(null, signed, publicKey, signature)
    } catch {
      return false
    }
  })
  return valid ? { ok: true } : { ok: false, reason: "bad_signature" }
}

/**
 * Lets through only IBEX Hub deliveries signed by the configured webhook key.
 * Needs the raw body (express.raw) on req.body; parses it as JSON for the
 * handler after the check.
 *
 * Without a usable key every delivery gets 503 and an error log: IBEX retries
 * once and drops the event, and the hourly deposit matcher still records the
 * credit. That is the state between deploying this route and storing the key
 * that registering the webhook returns.
 */
export const verifyIbexHubSignature = (
  req: Request,
  resp: Response,
  next: NextFunction,
) => {
  if (!hubPublicKey) {
    logger.error(
      { path: req.path },
      "IBEX Hub webhook delivery refused: ibex.webhook.hub.publicKey is not a usable Ed25519 key",
    )
    return resp.status(503).end("Not configured")
  }

  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
  const check = checkHubSignature({
    webhookId: req.header("webhook-id"),
    timestamp: req.header("webhook-timestamp"),
    signatureHeader: req.header("webhook-signature"),
    rawBody,
    publicKey: hubPublicKey,
  })
  if (!check.ok) {
    logger.warn(
      { reason: check.reason, webhookId: req.header("webhook-id") },
      "Rejected IBEX Hub webhook delivery",
    )
    return resp.status(401).end("Unauthorized")
  }

  try {
    req.body = JSON.parse(rawBody.toString("utf8"))
  } catch {
    return resp.status(400).end("Invalid JSON")
  }
  next()
}

export { parseHubPublicKey }
