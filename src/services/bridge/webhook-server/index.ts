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
// every webhook into a 500. Skipping that validation degrades an unset trust
// proxy to keying on the LB's socket address (one shared bucket) instead of an
// outage. Set `trust proxy` in the server for per-sender buckets.
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
