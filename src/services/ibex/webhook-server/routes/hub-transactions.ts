import express, { Request, Response } from "express"
import rateLimitMiddleware from "express-rate-limit"

import { recordIbexCreditSignal } from "@app/bridge/match-ibex-deposits"
import { baseLogger } from "@services/logger"
import { ibexWebhookPaths } from "@services/ibex/webhook-config"

import { validateIbexHubIp, verifyIbexHubSignature } from "../middleware"

const paths = ibexWebhookPaths.hub

const router = express.Router()

// The organization webhook reports every transaction on every account, not
// just crypto receives, so the limit is well above Flash's peak payment rate.
const webhookRateLimit = rateLimitMiddleware({
  windowMs: 60_000,
  limit: 1200,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
})

// The signature covers the exact bytes IBEX sent, so this route reads the raw
// body; the server mounts it before its JSON parser.
const rawBody = express.raw({ type: () => true, limit: "256kb" })

const IBEX_CRYPTO_RECEIVE_TYPE_ID = 9

/**
 * IBEX Hub's organization webhook, event "Transactions" (ENG-891). It is the
 * only notice IBEX gives of a USDT credit on a Bridge deposit address.
 *
 * IBEX waits 4 seconds, retries once on an error and then drops the event,
 * so the handler answers 200 first and does the work after. Only crypto
 * receives are acted on, and only through recordIbexCreditSignal, which reads
 * the transaction back from IBEX instead of trusting this body. A dropped or
 * failed one is recorded by the hourly matcher.
 */
const hubTransactionsHandler = (req: Request, res: Response) => {
  res.status(200).json({ status: "received" })

  const body = req.body as {
    event?: string
    transaction?: { id?: unknown; transactionTypeId?: unknown; status?: unknown }
  }
  const transaction = body?.transaction
  const webhookId = req.header("webhook-id")
  // One line per delivery, without the body, as the legacy IBEX routes log
  // theirs: it shows deliveries arriving before any crypto receive does.
  baseLogger.info(
    {
      webhookId,
      event: body?.event,
      transactionTypeId: transaction?.transactionTypeId,
      status: transaction?.status,
    },
    "IBEX Hub webhook delivery",
  )
  if (body?.event !== "Transactions" || typeof transaction?.id !== "string") return
  if (transaction.transactionTypeId !== IBEX_CRYPTO_RECEIVE_TYPE_ID) return

  recordIbexCreditSignal({ ibexTransactionId: transaction.id, webhookId })
    .then((result) =>
      baseLogger.info(
        { ibexTransactionId: transaction.id, webhookId, result },
        "IBEX Hub crypto receive handled",
      ),
    )
    .catch((error) =>
      baseLogger.error(
        { error, ibexTransactionId: transaction.id, webhookId },
        "IBEX Hub crypto receive handling threw",
      ),
    )
}

router.post(
  paths.transactions,
  webhookRateLimit,
  validateIbexHubIp,
  rawBody,
  verifyIbexHubSignature,
  hubTransactionsHandler,
)

export { hubTransactionsHandler, paths, router }
