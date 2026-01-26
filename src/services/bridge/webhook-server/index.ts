/**
 * Bridge Webhook Server
 * Standalone Express server for handling Bridge.xyz webhook events
 *
 * Runs on port configured in BridgeConfig.webhook.port (default: 4009)
 * Routes: /kyc, /deposit, /transfer
 */

import express from "express"
import { BridgeConfig } from "@config"
import { baseLogger } from "@services/logger"
import { verifyBridgeSignature } from "./middleware/verify-signature"
import { kycHandler } from "./routes/kyc"
import { depositHandler } from "./routes/deposit"
import { transferHandler } from "./routes/transfer"

export const startBridgeWebhookServer = () => {
  const app = express()

  // Middleware - MUST capture raw body for signature verification
  app.use(
    express.json({
      verify: (req: any, res, buf) => {
        req.rawBody = buf.toString("utf8")
      },
    }),
  )

  // Health check
  app.get("/health", (req, res) => {
    res.status(200).json({ status: "ok", service: "bridge-webhook" })
  })

  // Webhook routes with signature verification
  app.post("/kyc", verifyBridgeSignature("kyc"), kycHandler)
  app.post("/deposit", verifyBridgeSignature("deposit"), depositHandler)
  app.post("/transfer", verifyBridgeSignature("transfer"), transferHandler)

  // Start server
  const port = BridgeConfig.webhook.port
  app.listen(port, () => {
    baseLogger.info({ port }, "Bridge webhook server started")
  })
}
