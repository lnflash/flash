import express, { Request, Response } from "express"
import rateLimitMiddleware from "express-rate-limit"

import {
  IBEX_CRYPTO_RECEIVE_TYPE_ID,
  recordIbexCreditSignal,
} from "@app/bridge/match-ibex-deposits"
import { baseLogger } from "@services/logger"
import { ibexWebhookPaths } from "@services/ibex/webhook-config"
// Type only: erased at runtime, so the Bridge path never loads the POS module.
import type { PosUsdtHubOutcome } from "@services/pos-usdt-checkout/hub-signal"

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

// IBEX waits 4 seconds for an answer. Past this, recording is treated as
// failed and IBEX is asked to redeliver; a late write is harmless, as a
// redelivery finds the credit already stored.
const POS_RECORD_DEADLINE_MS = 3_000

const withinDeadline = <T>(work: Promise<T>, ms: number) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("POS USDT recording missed the acknowledgement deadline")),
      ms,
    )
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })

/**
 * IBEX Hub's organization webhook, event "Transactions" (ENG-891). It is the
 * only notice IBEX gives of a USDT credit on a Bridge deposit address.
 *
 * IBEX waits 4 seconds, retries once on an error and then drops the event.
 * Only crypto receives are acted on. The Bridge path goes through
 * recordIbexCreditSignal, which reads the transaction back from IBEX instead
 * of trusting this body, always after or alongside the answer and never
 * holding it up; a dropped or failed one is recorded by the hourly matcher.
 *
 * With POS_USDT_CHECKOUT_ENABLED, a signed crypto receive is also offered to
 * the POS USDT checkout, which ties it to a sale only by the event's
 * receiveInfo.id. That credit has no other notice, so the 200 waits until it
 * is durably stored (or known not to be a POS credit), and a storage failure
 * answers 503 so IBEX redelivers. No IBEX read happens before the answer: the
 * stored credit is read back after it, and the sale's status poll reads back
 * any credit still pending. Every other delivery is answered at once.
 */
const hubTransactionsHandler = async (req: Request, res: Response) => {
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
  const cryptoReceive =
    body?.event === "Transactions" &&
    typeof transaction?.id === "string" &&
    transaction.transactionTypeId === IBEX_CRYPTO_RECEIVE_TYPE_ID
  const posOn = process.env.POS_USDT_CHECKOUT_ENABLED === "true"

  if (!cryptoReceive || !posOn) res.status(200).json({ status: "received" })
  if (!cryptoReceive) return
  const ibexTransactionId = transaction?.id as string

  recordIbexCreditSignal({ ibexTransactionId, webhookId })
    .then((result) =>
      baseLogger.info(
        { ibexTransactionId, webhookId, result },
        "IBEX Hub crypto receive handled",
      ),
    )
    .catch((error) =>
      baseLogger.error(
        { error, ibexTransactionId, webhookId },
        "IBEX Hub crypto receive handling threw",
      ),
    )
  if (!posOn) return

  // POS USDT checkout, off by default. The Bridge path above is already
  // started and never waits on it; the module loads only when on.
  let outcome: PosUsdtHubOutcome
  try {
    outcome = await withinDeadline(
      import("@services/pos-usdt-checkout/hub-signal").then(({ recordPosUsdtHubEvent }) =>
        recordPosUsdtHubEvent(body),
      ),
      POS_RECORD_DEADLINE_MS,
    )
  } catch (error) {
    baseLogger.error(
      { error, ibexTransactionId, webhookId },
      "IBEX Hub POS USDT checkout could not record the credit; asking IBEX to retry",
    )
    res.status(503).json({ status: "retry" })
    return
  }
  res.status(200).json({ status: "received" })
  baseLogger.info(
    { ibexTransactionId, webhookId, result: outcome.result },
    "IBEX Hub crypto receive recorded for POS USDT checkout",
  )

  // After the answer: confirm the stored credit against IBEX. A failure here
  // leaves it DETECTED for the sale's status poll to read back.
  outcome
    .readBack?.()
    .then((result) =>
      baseLogger.info(
        { ibexTransactionId, webhookId, result },
        "IBEX Hub crypto receive handled for POS USDT checkout",
      ),
    )
    .catch((error) =>
      baseLogger.error(
        { error, ibexTransactionId, webhookId },
        "IBEX Hub POS USDT checkout read-back threw",
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
