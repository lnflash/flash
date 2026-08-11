import crypto from "crypto"

import express from "express"

import { FygaroConfig } from "@config"
import { baseLogger } from "@services/logger"
import { alertBridge, generateDedupKey } from "@services/alerts"

type RawBodyRequest = express.Request & { rawBody?: string }

/**
 * Page ops when a webhook rejection means OUR side is misconfigured — every one
 * of these 401s legitimate payments while the service looks healthy, the exact
 * gap that caused hours of silent card-top-up failures during setup. Three
 * cases fire:
 *   - a rotated/wrong shared secret ("we hold a secret but the HMAC didn't match")
 *   - no secrets configured at all
 *   - the server clock drifted past the skew window (NTP down / stuck clock),
 *     which 401s every real webhook on timestamp tolerance
 * Each uses a STATIC dedup key so the built-in TTL suppression collapses the
 * flood to one alert per window rather than one per rejected request. Clock skew
 * carries its OWN static key (generateDedupKey.fygaroClockSkew) so a stuck clock
 * and a bad secret never mask one another. Deliberately NOT fired for a plain
 * missing/malformed signature (random internet noise) — those never indicate a
 * misconfiguration and would be pure alert spam. Never carries the secret
 * itself — only the (public) key id.
 */
const SIGNATURE_FAILURE_TITLE =
  "Fygaro webhook signature verification failing — check the webhook secret"

const alertSignatureFailure = (
  reason: string,
  keyId?: string,
  overrides?: { dedupKey?: string; title?: string },
): void => {
  alertBridge({
    dedupKey: overrides?.dedupKey ?? generateDedupKey.fygaroSignatureFailure(),
    source: "fygaro-webhook",
    severity: "warning",
    title: overrides?.title ?? SIGNATURE_FAILURE_TITLE,
    detail: reason,
    context: { key_id: keyId },
  })
}

/**
 * Fygaro webhook signature verification.
 *
 * Fygaro signs every hook request with HMAC-SHA-256 over
 * `${timestamp}.${rawBody}` and sends:
 *   - `Fygaro-Signature`: `t=<timestamp>,v1=<hex hash>[,v1=<hex hash>...]`
 *     (multiple v1 entries appear during secret rotation)
 *   - `Fygaro-Key-ID`:   identifies which shared secret signed the request
 *
 * Secrets live in FygaroConfig.webhook.secrets keyed by that key id. When the
 * key id header is absent (or unknown ids should not hard-fail during
 * rotation), every configured secret is tried — the same approach Fygaro's
 * official `@fygaro/webhook` helper takes.
 */
const parseSignatureHeader = (
  header: string,
): { timestamp?: string; hashes: string[] } => {
  let timestamp: string | undefined
  const hashes: string[] = []
  for (const part of header.split(",")) {
    const [key, ...rest] = part.trim().split("=")
    const value = rest.join("=")
    if (key === "t" && value) timestamp = value
    if (key === "v1" && value) hashes.push(value)
  }
  return { timestamp, hashes }
}

const timingSafeHexEqual = (expectedHex: string, providedHex: string): boolean => {
  const expected = Buffer.from(expectedHex, "hex")
  const provided = Buffer.from(providedHex, "hex")
  // Buffer.from(_, "hex") stops at the first invalid character, so malformed
  // input degrades to a length mismatch rather than a throw.
  if (expected.length === 0 || expected.length !== provided.length) return false
  return crypto.timingSafeEqual(expected, provided)
}

export const verifyFygaroSignature = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => {
  try {
    const signatureHeader = req.headers["fygaro-signature"]
    if (!signatureHeader || typeof signatureHeader !== "string") {
      return res.status(401).json({ error: "Missing signature header" })
    }

    const keyId = req.headers["fygaro-key-id"]
    const secretsById = FygaroConfig.webhook?.secrets ?? {}
    const candidateSecrets =
      typeof keyId === "string" && keyId && secretsById[keyId]
        ? [secretsById[keyId]]
        : Object.values(secretsById)
    if (candidateSecrets.length === 0) {
      baseLogger.error(
        { keyId },
        "Fygaro webhook rejected: no webhook secrets configured",
      )
      alertSignatureFailure(
        "no webhook secrets configured",
        typeof keyId === "string" ? keyId : undefined,
      )
      return res.status(401).json({ error: "Webhook secret not configured" })
    }

    const { timestamp, hashes } = parseSignatureHeader(signatureHeader)
    if (!timestamp || hashes.length === 0) {
      return res.status(401).json({ error: "Invalid signature header" })
    }

    const timestampNum = Number(timestamp)
    if (!Number.isFinite(timestampNum)) {
      return res.status(401).json({ error: "Invalid signature timestamp" })
    }
    // Fygaro documents epoch seconds; tolerate milliseconds too (11+ digits
    // is past the year 5138 as seconds, so length disambiguates safely).
    const timestampMs = timestamp.length > 11 ? timestampNum : timestampNum * 1000
    const skewMs = FygaroConfig.webhook?.timestampSkewMs ?? 300000
    if (Math.abs(Date.now() - timestampMs) > skewMs) {
      baseLogger.warn({ timestamp }, "Fygaro webhook rejected: timestamp outside skew")
      // A one-off stale/replayed webhook is noise, but a SYSTEMATIC skew — our
      // clock drifted past the tolerance, or NTP is down — 401s every real
      // payment while the service looks healthy, the same silent-misconfig class
      // the secret alerts guard against. Fire with its own static dedup key so
      // replayed old webhooks collapse to one warning per window and a stuck
      // clock never masks (or is masked by) a bad-secret alert.
      alertSignatureFailure(
        "timestamp outside skew tolerance — check the server clock / NTP",
        typeof keyId === "string" ? keyId : undefined,
        {
          dedupKey: generateDedupKey.fygaroClockSkew(),
          title: "Fygaro webhook rejected: timestamp skew — check server clock/NTP",
        },
      )
      return res.status(401).json({ error: "Signature timestamp outside tolerance" })
    }

    const rawBody = (req as RawBodyRequest).rawBody
    if (!rawBody) {
      return res.status(400).json({ error: "Missing request body" })
    }

    // ASSUMPTION (verify against a real signed payment before trusting in
    // prod): Fygaro's docs and official helper libraries compare hex-encoded
    // HMAC digests. If a correctly-configured secret still 401s here, check
    // whether the digest encoding is base64 before suspecting the secret.
    const signedPayload = `${timestamp}.${rawBody}`
    const valid = candidateSecrets.some((secret) => {
      const expected = crypto
        .createHmac("sha256", secret)
        .update(signedPayload)
        .digest("hex")
      return hashes.some((hash) => timingSafeHexEqual(expected, hash))
    })
    if (!valid) {
      baseLogger.warn({ keyId }, "Fygaro webhook rejected: signature mismatch")
      alertSignatureFailure(
        "HMAC signature mismatch — secret likely rotated or wrong",
        typeof keyId === "string" ? keyId : undefined,
      )
      return res.status(401).json({ error: "Invalid signature" })
    }

    return next()
  } catch (error) {
    baseLogger.error({ error }, "Fygaro webhook signature verification error")
    return res.status(500).json({ error: "Signature verification failed" })
  }
}
