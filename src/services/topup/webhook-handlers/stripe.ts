import { Request } from "express"
import crypto from "crypto"
import { TopupConfig } from "@config"
import { BaseTopupWebhookHandler, TopupWebhookPayload } from "./base"
import { baseLogger as logger } from "@services/logger"

interface StripeWebhookPayload {
  id: string
  object: string
  api_version: string
  created: number
  type: string
  data: {
    object: {
      id: string
      object: string
      amount: number
      currency: string
      status: string
      metadata?: {
        username?: string
        wallet_type?: string
      }
      receipt_email?: string
      payment_intent?: string
      customer?: string
    }
  }
}

export class StripeWebhookHandler extends BaseTopupWebhookHandler {
  provider = "stripe"

  verifySignature(req: Request): boolean {
    const config = TopupConfig.providers.stripe
    if (!config?.webhook?.secret) {
      return true
    }

    const signature = req.headers["stripe-signature"] as string
    if (!signature) {
      logger.warn({ provider: this.provider }, "Missing webhook signature")
      return false
    }

    try {
      const elements = signature.split(",")
      const timestamp = elements.find((e) => e.startsWith("t="))?.substring(2)
      const sig = elements.find((e) => e.startsWith("v1="))?.substring(3)

      if (!timestamp || !sig) {
        return false
      }

      const rawBody = JSON.stringify(req.body)
      const payload = `${timestamp}.${rawBody}`
      const expectedSignature = crypto
        .createHmac("sha256", config.webhook.secret)
        .update(payload)
        .digest("hex")

      return crypto.timingSafeEqual(
        Buffer.from(sig),
        Buffer.from(expectedSignature)
      )
    } catch (error) {
      logger.error({ provider: this.provider, error }, "Error verifying Stripe signature")
      return false
    }
  }

  parsePayload(req: Request): TopupWebhookPayload | Error {
    try {
      const payload = req.body as StripeWebhookPayload

      if (payload.type !== "payment_intent.succeeded" && payload.type !== "charge.succeeded") {
        return new Error(`Unsupported Stripe event type: ${payload.type}`)
      }

      const paymentData = payload.data.object
      const username = paymentData.metadata?.username

      if (!username) {
        return new Error("Missing username in Stripe payment metadata")
      }

      const status = paymentData.status === "succeeded" ? "succeeded" :
                     paymentData.status === "failed" ? "failed" : "pending"

      return {
        provider: this.provider,
        transactionId: paymentData.id,
        amount: paymentData.amount / 100,
        currency: paymentData.currency.toUpperCase(),
        username,
        walletType: (paymentData.metadata?.wallet_type as "USD" | "BTC") || "USD",
        email: paymentData.receipt_email,
        status,
        metadata: {
          paymentIntent: paymentData.payment_intent,
          customer: paymentData.customer,
          createdAt: payload.created,
        },
      }
    } catch (error) {
      return error as Error
    }
  }
}