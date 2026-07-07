import express, { Request, Response } from "express"
import cors, { CorsOptions } from "cors"
import rateLimitMiddleware from "express-rate-limit"

import { WalletsRepository } from "@services/mongoose/wallets"
import { ZapRequestModel } from "@services/mongoose/zap-request"
import axios from "axios"
import { baseLogger as logger } from "@services/logger"
import { AccountsRepository } from "@services/mongoose"
import Ibex from "@services/ibex/client"
import { ibexWebhookPaths, ibexWebhookEndpoints } from "@services/ibex/webhook-config"
import { extractPaymentHashFromBolt11 } from "@utils"

import { authenticate, logRequest, validateIbexIp } from "../middleware"

const lnurlCorsOptions: CorsOptions = {
  origin: [
    "https://flashapp.me",
    "https://www.flashapp.me",
    "https://getflash.io",
    "https://www.getflash.io",
    "http://localhost:3000",
    "http://localhost:4002",
  ],
  methods: ["GET"],
}

const publicLnurlRateLimit = rateLimitMiddleware({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
})

const webhookRateLimit = rateLimitMiddleware({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
})

const paths = ibexWebhookPaths.onPay

const PAYMENT_HASH_RE = /^[0-9a-f]{64}$/i

export const buildVerifyUrl = (paymentHash: string): string =>
  ibexWebhookEndpoints.onPay.verify.replace(":paymentHash", paymentHash)

// LUD-21: settlement check for an invoice issued by the LNURL-pay callback
// above. The payment hash acts as an unguessable capability, so the endpoint
// is public (permissive CORS — web wallets poll it cross-origin).
export const lnurlVerifyHandler = async (req: Request, resp: Response) => {
  try {
    const { paymentHash } = req.params
    if (!paymentHash || !PAYMENT_HASH_RE.test(paymentHash)) {
      return resp.status(404).json({ status: "ERROR", reason: "Not found" })
    }

    const invoice = await Ibex.invoiceFromHash(paymentHash as PaymentHash)
    if (invoice instanceof Error || !invoice.bolt11) {
      return resp.status(404).json({ status: "ERROR", reason: "Not found" })
    }

    const settled = invoice.state?.name === "SETTLED" || Boolean(invoice.settleDateUtc)

    return resp.json({
      status: "OK",
      settled,
      preimage: settled && invoice.preImage ? invoice.preImage : null,
      pr: invoice.bolt11,
    })
  } catch (err) {
    logger.error({ err }, "LNURL-pay verify failed")
    return resp.status(404).json({ status: "ERROR", reason: "Not found" })
  }
}

const router = express.Router()

router.get(
  paths.lnurl,
  publicLnurlRateLimit,
  cors(lnurlCorsOptions),
  logRequest,
  async (req: Request, resp: Response) => {
    try {
      const { username } = req.params
      const { amount, nostr, comment } = req.query
      if (!username) return resp.status(400).json({ error: "username is required" })
      if (!amount) return resp.status(400).json({ error: "amount is required" })

      let requestEvent: unknown = null
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
      const wallet = await WalletsRepository().findById(account.defaultWalletId)
      if (!wallet || wallet instanceof Error) {
        return resp.status(404).json({ error: "No wallet found for this user" })
      }
      const lnurlp = wallet.lnurlp
      if (!lnurlp)
        return resp.status(404).json({ error: "No lnurlp found for this wallet" })

      // 2. Decode lnurlp to get invoice callback URL
      const decoded = await Ibex.decodeLnurl({ lnurl: lnurlp })
      if (decoded instanceof Error || !decoded.decodedLnurl)
        return resp.status(500).json({ error: "Couldn't decode users lnurl" })
      const callbackUrl = decoded.decodedLnurl
      if (!callbackUrl)
        return resp.status(500).json({ error: "Failed to decode lnurl callback URL" })
      const lnurlResponse = await axios.get(callbackUrl)
      const invoiceAddress = lnurlResponse.data.callback
      // 3. Call original invoice callback URL to generate invoice
      const invoiceResp = await axios.get(invoiceAddress, {
        params: {
          amount,
          comment: comment || "Zap payment",
        },
      })
      const { pr: bolt11, successAction } = invoiceResp.data
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
        await zapRecord.save()
      }

      // 5. Return LNURL-pay JSON (verify per LUD-21)
      return resp.json({
        pr: bolt11,
        successAction: successAction || null,
        routes: [],
        verify: buildVerifyUrl(invoiceHash),
      })
    } catch (err) {
      logger.error({ err }, "LNURL-pay proxy callback failed")
      return resp.status(500).json({ error: "Internal server error" })
    }
  },
)

router.get(
  paths.verify,
  publicLnurlRateLimit,
  cors({ origin: true, methods: ["GET"] }),
  logRequest,
  lnurlVerifyHandler,
)

// Keep other routes as stubs. These are Ibex webhooks (authenticated), so they
// are IP-restricted; the public GET /pay/lnurl/:username above is not.
router.post(
  paths.invoice,
  webhookRateLimit,
  validateIbexIp,
  authenticate,
  logRequest,
  async (_: Request, resp: Response) => resp.status(200).end(),
)
router.post(
  paths.onchain,
  webhookRateLimit,
  validateIbexIp,
  authenticate,
  logRequest,
  async (_: Request, resp: Response) => resp.status(200).end(),
)

export { paths, router }
