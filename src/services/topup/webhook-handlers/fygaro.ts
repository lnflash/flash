import { Request } from "express"
import crypto from "crypto"
import { TopupConfig } from "@config"
import { BaseTopupWebhookHandler, TopupWebhookPayload } from "./base"
import { baseLogger as logger } from "@services/logger"

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
    if (!config?.webhook?.secret) {
      return true
    }

    const signature = req.headers["x-fygaro-signature"] as string
    if (!signature) {
      logger.warn({ provider: this.provider }, "Missing webhook signature")
      return false
    }

    const rawBody = JSON.stringify(req.body)
    const expectedSignature = crypto
      .createHmac("sha256", config.webhook.secret)
      .update(rawBody)
      .digest("hex")

    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    )
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