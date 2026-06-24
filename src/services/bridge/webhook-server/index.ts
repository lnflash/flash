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
import { replayAuthMiddleware, replayHandler } from "./routes/replay"

type RawBodyRequest = express.Request & { rawBody?: string }

const webhookRateLimit = rateLimitMiddleware({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
})

const replayRateLimit = rateLimitMiddleware({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
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
  app.post("/internal/replay", replayRateLimit, replayAuthMiddleware, replayHandler)

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
