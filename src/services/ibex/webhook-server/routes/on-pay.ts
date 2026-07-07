import express, { Request, Response } from "express"
import cors, { CorsOptions } from "cors"
import rateLimitMiddleware from "express-rate-limit"

import { WalletsRepository } from "@services/mongoose/wallets"
import { ZapRequestModel } from "@services/mongoose/zap-request"
import { LnurlInvoiceModel } from "@services/mongoose/lnurl-invoice"
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

// LUD-21 wallets poll verify every 1-2s; a dedicated bucket keeps that
// polling from ever consuming the payment callback's budget (B3).
const verifyRateLimit = rateLimitMiddleware({
  windowMs: 60_000,
  limit: 60,
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

// IBEX invoice states: 0 OPEN / 1 SETTLED / 2 CANCEL / 3 ACCEPTED. The
// preimage is proof of payment, so its release is gated on the single strict
// signal (state.id === 1), same as payment-status-checker.
const IBEX_INVOICE_STATE_SETTLED = 1

// Settled results are immutable — cache them so wallet polling and
// attacker-supplied hashes don't amplify into repeated IBEX calls. Bounded
// FIFO: at 10k entries the oldest are evicted.
const settledVerifyCache = new Map<
  string,
  { settled: true; preimage: string | null; pr: string }
>()
const SETTLED_CACHE_MAX = 10_000

export const buildVerifyUrl = (paymentHash: string): string =>
  ibexWebhookEndpoints.onPay.verify.replace(":paymentHash", paymentHash)

const lnurlVerifyNotFound = (resp: Response) =>
  // LNURL convention (LUD-06 lineage) is HTTP 200 with a status:ERROR body —
  // some wallet libs treat non-2xx as transport failure and never parse it.
  resp.json({ status: "ERROR", reason: "Not found" })

// LUD-21: settlement check, scoped to invoices ISSUED BY the LNURL-pay
// callback above (recorded in LnurlInvoiceModel). Payment hashes are not
// secrets — routing nodes and anyone shown the invoice see them — so verify
// must not answer for arbitrary Flash/IBEX invoices. Public endpoint,
// permissive CORS: web wallets poll it cross-origin.
export const lnurlVerifyHandler = async (req: Request, resp: Response) => {
  try {
    const rawHash = req.params.paymentHash
    if (!rawHash || !PAYMENT_HASH_RE.test(rawHash)) {
      return lnurlVerifyNotFound(resp)
    }
    const paymentHash = rawHash.toLowerCase()

    const cached = settledVerifyCache.get(paymentHash)
    if (cached) {
      return resp.json({ status: "OK", ...cached })
    }

    // Scope check first: unknown hashes never reach IBEX
    const issued = await LnurlInvoiceModel.exists({ invoiceHash: paymentHash })
    if (!issued) {
      logger.info(
        { route: "lnurl-verify", hashPrefix: paymentHash.slice(0, 8) },
        "verify: hash not issued by this proxy",
      )
      return lnurlVerifyNotFound(resp)
    }

    const invoice = await Ibex.invoiceFromHash(paymentHash as PaymentHash)
    if (invoice instanceof Error || !invoice.bolt11) {
      logger.warn(
        { route: "lnurl-verify", hashPrefix: paymentHash.slice(0, 8) },
        "verify: issued hash not resolvable at IBEX",
      )
      return lnurlVerifyNotFound(resp)
    }

    const settled = invoice.state?.id === IBEX_INVOICE_STATE_SETTLED
    const result = {
      settled,
      preimage: settled && invoice.preImage ? invoice.preImage : null,
      pr: invoice.bolt11,
    }

    if (settled) {
      if (settledVerifyCache.size >= SETTLED_CACHE_MAX) {
        const oldest = settledVerifyCache.keys().next().value
        if (oldest) settledVerifyCache.delete(oldest)
      }
      settledVerifyCache.set(paymentHash, { ...result, settled: true })
    }

    logger.info(
      { route: "lnurl-verify", hashPrefix: paymentHash.slice(0, 8), settled },
      "verify: answered",
    )
    return resp.json({ status: "OK", ...result })
  } catch (err) {
    logger.error({ err }, "LNURL-pay verify failed")
    return lnurlVerifyNotFound(resp)
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

      // 4a. Record the issued hash so LUD-21 verify answers for it (scope
      // guard — see lnurlVerifyHandler). Never blocks invoice delivery.
      try {
        await LnurlInvoiceModel.create({
          invoiceHash: invoiceHash.toLowerCase(),
          accountUsername: username,
        })
      } catch (err) {
        logger.warn(
          { err, hashPrefix: invoiceHash.slice(0, 8) },
          "Failed to record LNURL invoice for verify — verify will 404 for it",
        )
      }

      // 4b. Save zap request in Mongo
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
  verifyRateLimit,
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
