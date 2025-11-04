import express, { Request, Response } from "express"
import { authenticate, logRequest } from "../middleware"
import { ZapRequestModel } from "@services/mongoose/zap-request"
import { baseLogger as logger } from "@services/logger"
import { AccountsRepository } from "@services/mongoose"
import { bech32 } from "bech32"

import IbexClient from "ibex-client"
import { IbexConfig } from "@config"
import { Redis } from "@services/ibex/cache"
import { onReceive } from "."

const paths = {
  invoice: "/pay/invoice",
  lnurl: "/pay/lnurl/:username",
  onchain: "/pay/onchain",
}

const Ibex = new IbexClient(
  IbexConfig.url,
  { email: IbexConfig.email, password: IbexConfig.password },
  Redis,
)

export function decodeLnurl(lnurl: string): { callback: string } {
  try {
    const decoded = bech32.decode(lnurl, 1500)
    const bytes = bech32.fromWords(decoded.words)
    const url = Buffer.from(bytes).toString()
    return { callback: url }
  } catch (err) {
    throw new Error("Failed to decode lnurl: " + err)
  }
}

const router = express.Router()

router.get(paths.lnurl, logRequest, async (req: Request, resp: Response) => {
  try {
    const { username } = req.params
    const { amount, nostr, comment } = req.query
    if (!username) return resp.status(400).json({ error: "username is required" })
    if (!amount) return resp.status(400).json({ error: "amount is required" })

    let requestEvent: any | null = null
    if (nostr) {
      try {
        requestEvent = JSON.parse(decodeURIComponent(nostr as string))
      } catch (err) {
        logger.warn({ err, nostr }, "Failed to decode nostr in proxy callback")
        requestEvent = null
      }
    }
    // 1. Lookup wallet for the user
    const account = await AccountsRepository().findByUsername(username as Username)
    if (account instanceof Error) {
      return resp.status(404).json({ error: "User not found" })
    }

    const invoiceResponse = await Ibex.addInvoice({
      accountId: account.defaultWalletId,
      memo: (comment as string) || "Zap!",
      amount: Number(amount),
      webhookUrl: IbexConfig.webhook.uri + onReceive.paths.zap,
      webhookSecret: IbexConfig.webhook.secret,
    })
    if (invoiceResponse instanceof Error) {
      return resp.status(500).json({ error: "Could Not generate invoice" })
    }

    const bolt11 = invoiceResponse.invoice?.bolt11
    if (!bolt11) return resp.status(500).json({ error: "Failed to generate invoice" })

    // Extract payment hash from bolt11 (or use library if needed)
    const invoiceHash = extractPaymentHashFromBolt11(bolt11)
    if (!invoiceHash)
      return resp.status(500).json({ error: "Failed to extract payment hash" })

    // 4. Save zap request in Mongo
    if (requestEvent) {
      const zapRecord = new ZapRequestModel({
        bolt11,
        invoiceHash,
        accountUsername: username,
        nostrJson: JSON.stringify(requestEvent),
        amountMsat: amount,
        createdAt: new Date(),
        fulfilled: false,
      })
      const document = await zapRecord.save()
    }

    // 5. Return LNURL-pay JSON
    return resp.json({
      pr: bolt11,
      routes: [],
    })
  } catch (err) {
    logger.error({ err }, "LNURL-pay proxy callback failed")
    return resp.status(500).json({ error: "Internal server error" })
  }
})

// Keep other routes as stubs
router.post(paths.invoice, authenticate, logRequest, async (_: Request, resp: Response) =>
  resp.status(200).end(),
)
router.post(paths.onchain, authenticate, logRequest, async (_: Request, resp: Response) =>
  resp.status(200).end(),
)

export { paths, router }

/**
 * Helper: extract payment hash from bolt11
 * You can use a proper BOLT11 decoding library if available
 */
function extractPaymentHashFromBolt11(bolt11: string): string | null {
  try {
    const decoded = require("bolt11").decode(bolt11)
    const hashTag = decoded.tags.find((t: any) => t.tagName === "payment_hash")
    return hashTag?.data || null
  } catch {
    return null
  }
}
