import express, { Request, Response } from "express"
import rateLimitMiddleware from "express-rate-limit"
import {
  recordIbexCryptoReceive,
  type CryptoReceiveErrorCode,
} from "@app/bridge/record-crypto-receive"
import { baseLogger } from "@services/logger"
import { ibexWebhookPaths } from "@services/ibex/webhook-config"

import { authenticate, logRequest, validateIbexIp } from "../middleware"

const paths = ibexWebhookPaths.cryptoReceive

const router = express.Router()

const webhookRateLimit = rateLimitMiddleware({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  // Without Express `trust proxy`, express-rate-limit v7 throws
  // ERR_ERL_UNEXPECTED_X_FORWARDED_FOR on any request carrying X-Forwarded-For
  // (i.e. anything behind an LB), turning every webhook into a 500. Skip that
  // validation so an unset trust proxy degrades to keying on the LB's socket
  // address (one shared bucket) instead of an outage. Set `trust proxy` in the
  // server for per-sender buckets.
  validate: { xForwardedForHeader: false },
})

const statusByErrorCode: Record<CryptoReceiveErrorCode, number> = {
  account_not_found: 404,
  wallet_list_failed: 500,
  usdt_wallet_not_found: 404,
  invalid_amount: 400,
  persist_failed: 500,
  erpnext_audit_failed: 500,
  internal_error: 500,
}

const cryptoReceiveHandler = async (req: Request, res: Response) => {
  const { tx_hash, address, amount, currency, network } = req.body
  const normalizedCurrency = String(currency || "").toUpperCase()
  const normalizedNetwork = String(network || "").toLowerCase()

  if (
    !tx_hash ||
    !address ||
    !amount ||
    normalizedCurrency !== "USDT" ||
    normalizedNetwork !== "ethereum"
  ) {
    baseLogger.warn(
      { tx_hash, address, amount, currency, network },
      "Invalid crypto receive payload",
    )
    return res.status(400).json({ error: "Invalid payload" })
  }

  const result = await recordIbexCryptoReceive({
    txHash: String(tx_hash),
    address: String(address),
    amount,
    currency: normalizedCurrency,
    network: normalizedNetwork,
    rawPayload: req.body,
  })

  if (result instanceof Error) {
    baseLogger.warn(
      { tx_hash, error: result },
      "Lock acquisition failed or duplicate webhook",
    )
    return res.status(200).json({ status: "already_processed" })
  }

  if (result.status === "success") {
    return res.status(200).json({ status: "success" })
  }
  if (result.status === "already_processed") {
    return res.status(200).json({ status: "already_processed" })
  }

  return res.status(statusByErrorCode[result.code] || 500).json({ error: result.code })
}

router.post(
  paths.cryptoReceive,
  webhookRateLimit,
  validateIbexIp,
  authenticate,
  logRequest,
  cryptoReceiveHandler,
)

export { cryptoReceiveHandler, paths, router }
