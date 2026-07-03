/**
 * Bridge Webhook Server
 * Standalone Express server for handling Bridge.xyz webhook events
 *
 * Runs on port configured in BridgeConfig.webhook.port (default: 4009)
 * Routes: /kyc, /deposit, /transfer
 */

import express from "express"
import rateLimitMiddleware from "express-rate-limit"
import { BridgeConfig } from "@config"
import { baseLogger } from "@services/logger"

import { verifyBridgeSignature } from "./middleware/verify-signature"
import { kycHandler } from "./routes/kyc"
import { depositHandler } from "./routes/deposit"
import { transferHandler } from "./routes/transfer"
import { externalAccountHandler } from "./routes/external-account"
import {
  replayAuthMiddleware,
  replayHandler,
  replayIngressMiddleware,
} from "./routes/replay"

type RawBodyRequest = express.Request & { rawBody?: string }

// `validate: { xForwardedForHeader: false }` on both limiters: without Express
// `trust proxy`, express-rate-limit v7 throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
// on any request carrying X-Forwarded-For (i.e. anything behind an LB), turning
// every webhook into a 500. `trust proxy` is set on the app (see below), which
// makes this validation moot; the skip stays so a future trust-proxy
// misconfiguration degrades to one shared bucket instead of an outage.
const webhookRateLimit = rateLimitMiddleware({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
})

const replayRateLimit = rateLimitMiddleware({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
})

export const startBridgeWebhookServer = () => {
  const app = express()

  // Exactly one XFF-writing hop sits in front of the pod: the nginx ingress
  // (the DO load balancer is L4 and does not touch headers). Trusting that one
  // hop makes req.ip the real sender — per-sender rate-limit buckets and a
  // non-spoofable IP for the replay allowlist — while entries a client forges
  // into X-Forwarded-For stay untrusted.
  app.set("trust proxy", 1)

  // Middleware - MUST capture raw body for signature verification
  app.use(
    express.json({
      verify: (req, res, buf) => {
        if (res.writableEnded) {
          return
        }
        const rawReq = req as RawBodyRequest
        rawReq.rawBody = buf.toString("utf8")
      },
    }),
  )

  // Health check
  app.get("/health", (req, res) => {
    res.status(200).json({ status: "ok", service: "bridge-webhook" })
  })

  // Webhook routes with signature verification
  app.post("/kyc", webhookRateLimit, verifyBridgeSignature("kyc"), kycHandler)
  app.post("/deposit", webhookRateLimit, verifyBridgeSignature("deposit"), depositHandler)
  app.post(
    "/transfer",
    webhookRateLimit,
    verifyBridgeSignature("transfer"),
    transferHandler,
  )
  app.post(
    "/external-account",
    webhookRateLimit,
    verifyBridgeSignature("external_account"),
    externalAccountHandler,
  )
  app.post(
    "/internal/replay",
    replayRateLimit,
    replayIngressMiddleware,
    replayAuthMiddleware,
    replayHandler,
  )

  if (!(process.env.BRIDGE_WEBHOOK_REPLAY_SECRET || BridgeConfig.webhook.replaySecret)) {
    baseLogger.warn(
      "replaySecret not configured (neither BridgeConfig.webhook.replaySecret nor BRIDGE_WEBHOOK_REPLAY_SECRET) — /internal/replay will reject all requests with 503",
    )
  }

  // Start server
  const port = BridgeConfig.webhook.port
  app.listen(port, () => {
    baseLogger.info({ port }, "Bridge webhook server started")
  })
}
