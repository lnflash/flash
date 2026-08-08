/**
 * Fygaro Webhook Server
 * Standalone Express server for handling Fygaro payment-button hook events.
 * Mirrors the Bridge webhook server structure.
 *
 * Runs on port configured in FygaroConfig.webhook.port (default: 4010)
 * Routes: /payment
 */

import express from "express"
import rateLimitMiddleware from "express-rate-limit"

import { FygaroConfig } from "@config"
import { baseLogger } from "@services/logger"

import { verifyFygaroSignature } from "./middleware/verify-signature"
import { fygaroEnabledGuard } from "./middleware/enabled-guard"
import { paymentHandler } from "./routes/payment"

type RawBodyRequest = express.Request & { rawBody?: string }

// `validate: { xForwardedForHeader: false }`: without Express `trust proxy`,
// express-rate-limit v7 throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR on any
// request carrying X-Forwarded-For (i.e. anything behind an LB), turning
// every webhook into a 500. `trust proxy` is set on the app (see below); the
// skip stays so a future trust-proxy misconfiguration degrades to one shared
// bucket instead of an outage.
const webhookRateLimit = rateLimitMiddleware({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
})

export const startFygaroWebhookServer = () => {
  const app = express()

  // Exactly one XFF-writing hop sits in front of the pod: the nginx ingress
  // (the DO load balancer is L4 and does not touch headers).
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
    res.status(200).json({ status: "ok", service: "fygaro-webhook" })
  })

  app.use(fygaroEnabledGuard)

  app.post("/payment", webhookRateLimit, verifyFygaroSignature, paymentHandler)

  if (Object.keys(FygaroConfig.webhook?.secrets ?? {}).length === 0) {
    baseLogger.warn(
      "No Fygaro webhook secrets configured (fygaro.webhook.secrets) — /payment will reject all requests with 401",
    )
  }

  // Start server
  const port = FygaroConfig.webhook?.port ?? 4010
  app.listen(port, () => {
    baseLogger.info({ port }, "Fygaro webhook server started")
  })
}
