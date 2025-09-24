import { Request } from "express"
import crypto from "crypto"
import { TopupConfig } from "@config"
import { BaseTopupWebhookHandler, TopupWebhookPayload } from "./base"
import { baseLogger as logger } from "@services/logger"

interface PayPalWebhookPayload {
  id: string
  create_time: string
  resource_type: string
  event_type: string
  summary: string
  resource: {
    id: string
    status: string
    amount: {
      total: string
      currency: string
    }
    custom_id?: string
    invoice_id?: string
    payer?: {
      email_address?: string
      payer_id?: string
    }
  }
}

export class PayPalWebhookHandler extends BaseTopupWebhookHandler {
  provider = "paypal"

  verifySignature(req: Request): boolean {
    const config = TopupConfig.providers.paypal
    if (!config?.webhook?.secret) {
      return true
    }

    const transmissionId = req.headers["paypal-transmission-id"] as string
    const transmissionTime = req.headers["paypal-transmission-time"] as string
    const certUrl = req.headers["paypal-cert-url"] as string
    const authAlgo = req.headers["paypal-auth-algo"] as string
    const transmissionSig = req.headers["paypal-transmission-sig"] as string

    if (!transmissionId || !transmissionTime || !transmissionSig) {
      logger.warn({ provider: this.provider }, "Missing PayPal webhook headers")
      return false
    }

    try {
      const rawBody = JSON.stringify(req.body)
      const expectedSig = `${transmissionId}|${transmissionTime}|${config.webhook.secret}|${crypto
        .createHash("sha256")
        .update(rawBody)
        .digest("hex")}`

      const hash = crypto
        .createHash("sha256")
        .update(expectedSig)
        .digest("hex")

      return hash === transmissionSig
    } catch (error) {
      logger.error({ provider: this.provider, error }, "Error verifying PayPal signature")
      return false
    }
  }

  parsePayload(req: Request): TopupWebhookPayload | Error {
    try {
      const payload = req.body as PayPalWebhookPayload

      if (!payload.event_type.includes("PAYMENT") || !payload.event_type.includes("COMPLETED")) {
        return new Error(`Unsupported PayPal event type: ${payload.event_type}`)
      }

      const username = payload.resource.custom_id
      if (!username) {
        return new Error("Missing username in PayPal payment custom_id")
      }

      const status = payload.resource.status === "COMPLETED" ? "succeeded" :
                     payload.resource.status === "FAILED" ? "failed" : "pending"

      const [walletType, actualUsername] = username.includes(":")
        ? username.split(":")
        : ["USD", username]

      return {
        provider: this.provider,
        transactionId: payload.resource.id,
        amount: parseFloat(payload.resource.amount.total),
        currency: payload.resource.amount.currency,
        username: actualUsername,
        walletType: walletType as "USD" | "BTC",
        email: payload.resource.payer?.email_address,
        status,
        metadata: {
          eventId: payload.id,
          eventType: payload.event_type,
          payerId: payload.resource.payer?.payer_id,
          createdAt: payload.create_time,
        },
      }
    } catch (error) {
      return error as Error
    }
  }
}