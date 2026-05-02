/**
 * Bridge Webhook Signature Verification Middleware
 *
 * Bridge uses asymmetric signature verification (RSA-SHA256), not HMAC.
 * Header format: X-Webhook-Signature: t=<timestamp_ms>,v0=<base64_signature>
 * Signature is computed over: <timestamp>.<raw_body>
 */

import { Request, Response, NextFunction } from "express"
import crypto from "crypto"
import { BridgeConfig } from "@config"
import { baseLogger } from "@services/logger"

export const verifyBridgeSignature = (publicKeyType: "kyc" | "deposit" | "transfer") => {
  return (req: Request, res: Response, next: NextFunction) => {
    const signature = req.headers["x-webhook-signature"] as string

    if (!signature) {
      baseLogger.warn("Missing Bridge webhook signature")
      return res.status(401).json({ error: "Missing signature" })
    }

    // Parse signature header: t=<timestamp>,v0=<signature>
    const parts = signature.split(",")
    const timestampPart = parts.find((p) => p.startsWith("t="))
    const signaturePart = parts.find((p) => p.startsWith("v0="))

    if (!timestampPart || !signaturePart) {
      baseLogger.warn("Invalid signature format")
      return res.status(401).json({ error: "Invalid signature format" })
    }

    const timestamp = timestampPart.slice("t=".length)
    const sig = signaturePart.slice("v0=".length)

    // Check timestamp skew (default 5 minutes)
    const now = Date.now()
    const timestampMs = parseInt(timestamp, 10)
    if (isNaN(timestampMs) || !isFinite(timestampMs)) {
      baseLogger.warn({ timestamp }, "Invalid timestamp format in Bridge webhook signature")
      return res.status(401).json({ error: "Invalid signature format" })
    }

    const skew = Math.abs(now - timestampMs)

    if (skew > BridgeConfig.webhook.timestampSkewMs) {
      baseLogger.warn({ skew }, "Webhook timestamp too old")
      return res.status(401).json({ error: "Timestamp too old" })
    }

    // Verify signature using Bridge public key
    const publicKey = BridgeConfig.webhook.publicKeys[publicKeyType]
    const rawBody = (req as any).rawBody

    if (!rawBody) {
      baseLogger.warn(`Missing raw body for webhook`)
      return res.status(401).json({ error: "Missing raw body" })
    }

    const signedPayload = `${timestamp}.${rawBody}`

    const digest = crypto.createHash("sha256").update(signedPayload).digest()
    baseLogger.debug({ signedPayload, digest: digest.toString("hex") }, "Verifying Bridge webhook signature")

    try {
      const verifier = crypto.createVerify("RSA-SHA256")
      verifier.update(digest)
      const isValid = verifier.verify(publicKey, sig, "base64")

      if (!isValid) {
        baseLogger.warn("Invalid Bridge webhook signature")
        return res.status(401).json({ error: "Invalid signature" })
      }

      next()
    } catch (error) {
      baseLogger.error({ error }, "Error verifying Bridge webhook signature")
      return res.status(500).json({ error: "Signature verification failed" })
    }
  }
}
