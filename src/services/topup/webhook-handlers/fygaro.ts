import crypto from "crypto"

import { Request } from "express"

import { TopupConfig } from "@config"

import { baseLogger as logger } from "@services/logger"

import { BaseTopupWebhookHandler, TopupWebhookPayload } from "./base"

interface FygaroWebhookPayload {
  event: "payment.succeeded" | "payment.failed" | "payment.pending"
  payment: {
    id: string
    amount: number
    currency: string
    status: "succeeded" | "failed" | "pending"
    customer: {
      email?: string
      name?: string
    }
    metadata?: {
      client_reference?: string
      wallet_type?: string
    }
    created_at: string
    payment_method?: string
  }
}

export class FygaroWebhookHandler extends BaseTopupWebhookHandler {
  provider = "fygaro"

  verifySignature(req: Request): boolean {
    const config = TopupConfig.providers.fygaro

    // If Fygaro doesn't provide a webhook secret, we can't verify signatures
    // In this case, you should consider:
    // 1. IP whitelisting (if Fygaro provides their IP ranges)
    // 2. Validating the webhook payload structure
    // 3. Using HTTPS to ensure the request is encrypted

    if (!config?.webhook?.secret) {
      logger.info(
        {
          provider: this.provider,
          ip: req.ip,
          headers: req.headers,
        },
        "Fygaro webhook received - no secret configured for verification",
      )

      // TODO: Add IP whitelist check here if Fygaro provides their IP ranges
      // Example:
      // const allowedIPs = ['1.2.3.4', '5.6.7.8'] // Get from Fygaro docs
      // if (!allowedIPs.includes(req.ip)) {
      //   logger.warn({ ip: req.ip }, "Webhook from unknown IP")
      //   return false
      // }

      return true // Accept webhook without signature verification
    }

    // If a secret is configured (for future use or testing), verify it
    const signatureHeader = req.headers["fygaro-signature"] as string

    if (!signatureHeader) {
      // No signature header but secret configured - could be legitimate
      logger.info({ provider: this.provider }, "No signature header - accepting webhook")
      return true
    }

    try {
      // Try standard HMAC verification if signature is provided
      const rawBody = JSON.stringify(req.body)
      const expectedSignature = crypto
        .createHmac("sha256", config.webhook.secret)
        .update(rawBody)
        .digest("hex")

      // Check if signature matches directly or with common variations
      if (
        signatureHeader === expectedSignature ||
        signatureHeader === `sha256=${expectedSignature}` ||
        signatureHeader.includes(expectedSignature)
      ) {
        return true
      }

      logger.warn(
        {
          provider: this.provider,
          provided: signatureHeader.substring(0, 20) + "...",
          expected: expectedSignature.substring(0, 20) + "...",
        },
        "Signature mismatch",
      )

      return false
    } catch (error) {
      logger.error({ provider: this.provider, error }, "Error verifying signature")
      return false
    }
  }

  parsePayload(req: Request): TopupWebhookPayload | Error {
    try {
      const payload = req.body as FygaroWebhookPayload

      if (!payload.payment) {
        return new Error("Invalid Fygaro webhook payload: missing payment object")
      }

      const username = payload.payment.metadata?.client_reference
      if (!username) {
        return new Error("Missing username in Fygaro payment metadata")
      }

      return {
        provider: this.provider,
        transactionId: payload.payment.id,
        amount: payload.payment.amount,
        currency: payload.payment.currency,
        username,
        walletType: (payload.payment.metadata?.wallet_type as "USD" | "BTC") || "USD",
        email: payload.payment.customer?.email,
        status: payload.payment.status,
        metadata: {
          paymentMethod: payload.payment.payment_method,
          createdAt: payload.payment.created_at,
        },
      }
    } catch (error) {
      return error as Error
    }
  }
}
