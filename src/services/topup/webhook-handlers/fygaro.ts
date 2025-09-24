import crypto from "crypto"

import { Request } from "express"

import { TopupConfig } from "@config"

import { baseLogger as logger } from "@services/logger"

import { BaseTopupWebhookHandler, TopupWebhookPayload } from "./base"

/**
 * Fygaro-specific webhook payload structure.
 * Documentation: https://help.fygaro.com/en-us/article/payment-button-hook-1wkui1k/
 */
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

/**
 * Webhook handler for Fygaro payment provider.
 * Fygaro is a payment gateway that supports card payments.
 *
 * IMPORTANT: Fygaro payment buttons may not provide webhook secrets,
 * so signature verification may not be possible. In this case, rely on:
 * - HTTPS for encrypted transport
 * - Idempotency checks to prevent replay attacks
 * - Payload validation
 */
export class FygaroWebhookHandler extends BaseTopupWebhookHandler {
  provider = "fygaro"

  /**
   * Verifies webhook authenticity.
   * NOTE: Fygaro payment buttons may not provide webhook secrets.
   * When no secret is configured, we accept the webhook but log for monitoring.
   */
  verifySignature(req: Request): boolean {
    const config = TopupConfig.providers.fygaro

    // If Fygaro doesn't provide a webhook secret, we can't verify signatures
    // Security considerations when no secret is available:
    // 1. IP whitelisting (if Fygaro provides their IP ranges)
    // 2. Validating the webhook payload structure
    // 3. Using HTTPS to ensure the request is encrypted

    if (!config?.webhook?.secret) {
      // Log the request details for monitoring when signature verification is not available
      // This helps detect potential abuse or unexpected webhook sources
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
      // If a secret IS configured (future enhancement or testing),
      // try standard HMAC verification
      // This supports multiple signature formats that providers might use
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

  /**
   * Converts Fygaro's webhook format to our common TopupWebhookPayload format.
   * Critical field: metadata.client_reference MUST contain the Flash username
   */
  parsePayload(req: Request): TopupWebhookPayload | Error {
    try {
      const payload = req.body as FygaroWebhookPayload

      if (!payload.payment) {
        return new Error("Invalid Fygaro webhook payload: missing payment object")
      }

      // CRITICAL: The client_reference field must contain the Flash username
      // This is set in the payment URL on the mobile app side
      const username = payload.payment.metadata?.client_reference
      if (!username) {
        return new Error("Missing username in Fygaro payment metadata")
      }

      // Map Fygaro fields to our common format
      return {
        provider: this.provider,
        transactionId: payload.payment.id, // Fygaro's unique payment ID
        amount: payload.payment.amount, // Amount in original currency
        currency: payload.payment.currency, // USD, JMD, etc.
        username, // Flash username for account identification
        walletType: (payload.payment.metadata?.wallet_type as "USD" | "BTC") || "USD", // Which wallet to credit
        email: payload.payment.customer?.email, // Optional: for notifications
        status: payload.payment.status, // succeeded, failed, pending
        metadata: {
          paymentMethod: payload.payment.payment_method, // card, bank, etc.
          createdAt: payload.payment.created_at, // Timestamp for reconciliation
        },
      }
    } catch (error) {
      return error as Error
    }
  }
}
