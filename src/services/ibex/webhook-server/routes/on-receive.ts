import express, { Request, Response, NextFunction } from "express"
import rateLimitMiddleware from "express-rate-limit"
import { notifyOpsEvent } from "@services/alerts/ops-events"
import { baseLogger, baseLogger as logger } from "@services/logger"
import { NotificationsService } from "@services/notifications"

import {
  AccountsRepository,
  UsersRepository,
  WalletsRepository,
} from "@services/mongoose"
import { RepositoryError } from "@domain/errors"
import { USDAmount, WalletCurrency } from "@domain/shared"
import {
  DeviceTokensNotRegisteredNotificationsServiceError,
  NotificationsServiceError,
} from "@domain/notifications"
import { getCurrentPriceAsDisplayPriceRatio } from "@app/prices"
import { getI18nInstance } from "@config"
import { getLanguageOrDefault } from "@domain/locale"
import { removeDeviceTokens } from "@app/users/remove-device-tokens"
import { buildLegs } from "@app/payment-splits/build-legs"
import { executePendingSplits } from "@app/payment-splits/execute-pending-splits"
import { resolveShadow } from "@app/payment-splits/receive-account"
import type { SplitReceiveAccountRecord } from "@services/mongoose/split-receive-accounts"
import { PaymentSplitRulesRepository } from "@services/mongoose/payment-split-rules"
import { ZapRequestModel } from "@services/mongoose/zap-request"
import { ZapPublisher } from "@services/nostr/zapPublisher"
import { ibexWebhookPaths } from "@services/ibex/webhook-config"

import { authenticate, logRequest, validateIbexIp } from "../middleware"

const USDT_MICROS_PER_MAJOR_UNIT = 1_000_000

interface PaymentContext {
  receiverWallet: Wallet
  recipientAccount: Account
  recipientUser: User
  // Set when the receive landed on a shadow receive account (ENG-717): the
  // settle middleware branches on it, and the notification replaces the plain
  // receive push with the split push.
  splitReceive?: { shadowId: string; walletId: string }
}

interface PaymentRequest extends Request {
  paymentContext?: PaymentContext
}

const fetchPaymentContext = async (
  req: PaymentRequest,
  resp: Response,
  next: NextFunction,
) => {
  const { transaction } = req.body
  const recipientWalletId = transaction.accountId

  // A receive on a shadow receive account resolves to the OWNING wallet's
  // account/user: the merchant must be notified, and the settle middleware
  // needs the shadow → wallet mapping. Looked up BEFORE WalletsRepository —
  // a shadow id is never a wallet id.
  //
  // Fail-OPEN on a resolve error (a Mongo blip): treat the receive as a plain
  // wallet receive. A 500 here makes IBEX redeliver and re-run notifications;
  // the reconcile rebuilds any missed shadow legs instead, so failing open
  // loses nothing but time.
  let shadow: SplitReceiveAccountRecord | null = null
  try {
    const resolved = await resolveShadow(recipientWalletId)
    if (resolved instanceof Error) {
      logger.error(
        resolved,
        `Failed to resolve split receive account with id ${recipientWalletId}; treating as a plain receive — the split reconcile will cover it`,
      )
    } else {
      shadow = resolved
    }
  } catch (err) {
    logger.error(
      { err, accountId: recipientWalletId },
      "split receive resolution threw; treating as a plain receive",
    )
  }

  const receiverWallet = await WalletsRepository().findById(
    (shadow?.walletId ?? recipientWalletId) as WalletId,
  )
  if (receiverWallet instanceof RepositoryError) {
    logger.error(receiverWallet, `Failed to fetch wallet with id ${recipientWalletId}`)
    return resp.sendStatus(500)
  }

  const recipientAccount = await AccountsRepository().findById(receiverWallet.accountId)
  if (recipientAccount instanceof Error) {
    logger.error(
      recipientAccount,
      `Failed to fetch account with id ${receiverWallet.accountId}`,
    )
    return resp.sendStatus(500)
  }

  const recipientUser = await UsersRepository().findById(recipientAccount.kratosUserId)
  if (recipientUser instanceof Error) {
    logger.error(
      recipientUser,
      `Failed to fetch user with kratos id ${recipientAccount.kratosUserId}`,
    )
    return resp.sendStatus(500)
  }
  req.paymentContext = {
    receiverWallet,
    recipientAccount,
    recipientUser,
    ...(shadow
      ? { splitReceive: { shadowId: recipientWalletId, walletId: receiverWallet.id } }
      : {}),
  }
  next()
}

// The receive time from the webhook body, so a rule created after the receive
// (a replay that lands after the merchant set or re-saved a split) never fires
// on it. Undefined when IBEX sent no parseable time.
const parseReceivedAt = (transaction: unknown): Date | undefined => {
  const tx = transaction as { settledAt?: unknown; createdAt?: unknown } | undefined
  for (const value of [tx?.settledAt, tx?.createdAt]) {
    if (typeof value !== "string" && typeof value !== "number") continue
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) return date
  }
  return undefined
}

// ENG-717: build (never send from this middleware — execution runs after
// next()) the payout legs for a receive settled on a shadow receive account.
// Failure here must not fail the webhook: IBEX would retry it and re-run the
// receive notification. The split reconcile re-reads shadow receives and
// builds any leg set this step missed: every paymentSplits.reconcileIntervalMs
// from this pod's split loop (lookback = interval plus margin) and once a day
// from the galoy cron (lookback = a day plus margin). Duplicate deliveries
// are duplicate-key no-ops.
//
// Execution runs fire-and-forget AFTER next() (see routes below): the webhook
// must return 200 fast, and a failed execution is the loop's retry problem.
const settleSplitReceive = async (
  req: PaymentRequest,
  _resp: Response,
  next: NextFunction,
) => {
  if (!req.paymentContext) return next()

  try {
    const { transaction } = req.body
    const paymentHash = parsePaymentHash(transaction?.invoice?.hash)
    const amount = Number(transaction?.amount)
    const { splitReceive, receiverWallet } = req.paymentContext
    if (splitReceive && paymentHash && Number.isFinite(amount)) {
      const built = await buildLegs({
        walletId: splitReceive.walletId,
        sourceIbexAccountId: splitReceive.shadowId,
        triggerKey: paymentHash,
        paymentHash,
        grossAmount: amount,
        currency: receiverWallet.currency,
        receivedAt: parseReceivedAt(transaction),
      })
      if (built instanceof Error) {
        logger.error(
          { err: built, walletId: splitReceive.walletId, paymentHash },
          "Failed to build split legs; the split reconcile will pick it up",
        )
      }
    }
  } catch (err) {
    logger.error(
      { err },
      "Failed to build split legs; the split reconcile will pick it up",
    )
  }

  next()
}

// Fire-and-forget executor kick after the response is on its way. Errors are
// logged, never thrown: the split loop retries everything still `pending`.
const executeSplitLegs = () => {
  executePendingSplits().catch((err) =>
    logger.error({ err }, "inline split execution failed; the split loop will retry"),
  )
}

const sendLightningNotification = async (
  req: PaymentRequest,
  resp: Response,
  next: NextFunction,
) => {
  if (!req.paymentContext) return next()

  const { transaction, receivedMsat } = req.body
  const receivedSat = receivedMsat / 1000
  const { receiverWallet, recipientAccount, recipientUser, splitReceive } =
    req.paymentContext

  // A receive on a shadow replaces the plain receive push with the split push:
  // the merchant's wallet is credited the NET moments later, so "received $50"
  // would be wrong. "Received $50 · $5 split to @partner" names both legs.
  if (splitReceive) {
    await sendSplitReceivedNotification(req)
    notifyOpsEvent({
      flow: "deposit",
      phase: "succeeded",
      status: "success",
      accountId: recipientAccount.id,
      amount: { value: transaction.amount, currency: receiverWallet.currency },
      meta: { type: "lightning", splitReceive: "true" },
    })
    return next()
  }

  const nsResp = await NotificationsService().lightningTxReceived({
    recipientAccountId: recipientAccount.id,
    recipientWalletId: receiverWallet.id,
    paymentAmount: toPaymentAmount(receiverWallet.currency)(transaction.amount),
    displayPaymentAmount: await toDisplayAmount(recipientAccount.displayCurrency)(
      receivedSat,
    ),
    paymentHash: transaction.invoice.hash,
    recipientDeviceTokens: recipientUser.deviceTokens,
    recipientNotificationSettings: recipientAccount.notificationSettings,
    recipientLanguage: recipientUser.language,
  })

  if (nsResp instanceof DeviceTokensNotRegisteredNotificationsServiceError) {
    await removeDeviceTokens({ userId: recipientUser.id, deviceTokens: nsResp.tokens })
  } else if (nsResp instanceof NotificationsServiceError) {
    logger.error(nsResp)
  }

  notifyOpsEvent({
    flow: "deposit",
    phase: "succeeded",
    status: "success",
    accountId: recipientAccount.id,
    amount: { value: transaction.amount, currency: receiverWallet.currency },
    meta: { type: "lightning" },
  })

  next()
}

// The split variant of the receive push (ENG-717): names the gross and where
// the shares went. Best-effort like every notification on a money path — the
// legs were already built and will pay regardless.
const i18n = getI18nInstance()

const sendSplitReceivedNotification = async (req: PaymentRequest): Promise<void> => {
  try {
    const { transaction } = req.body
    const { recipientUser, receiverWallet, splitReceive } = req.paymentContext!
    if (!splitReceive) return

    const rules = await PaymentSplitRulesRepository().listByWalletId(receiverWallet.id, {
      enabledOnly: true,
    })
    const destinations: string[] = []
    if (rules instanceof Error) {
      // The push still goes out without destination names: the merchant must
      // hear about the receive even when the split metadata is unreadable.
      logger.warn(rules, "could not list split rules for the receive push")
    } else {
      for (const rule of rules) {
        const wallet = await WalletsRepository().findById(
          rule.destinationWalletId as WalletId,
        )
        let name: string | undefined
        if (!(wallet instanceof Error)) {
          const account = await AccountsRepository().findById(wallet.accountId)
          if (!(account instanceof Error) && account.username)
            name = `@${account.username}`
        }
        destinations.push(name ?? rule.destinationWalletId)
      }
    }

    const locale = getLanguageOrDefault(recipientUser.language)
    const title = i18n.__({
      phrase: "notification.paymentSplit.received.title",
      locale,
    })
    const body = i18n.__(
      { phrase: "notification.paymentSplit.received.body", locale },
      { amount: Number(transaction.amount).toFixed(2), splits: destinations.join(", ") },
    )

    if (recipientUser.deviceTokens && recipientUser.deviceTokens.length > 0) {
      const nsResp = await NotificationsService().adminPushNotificationSend({
        deviceTokens: recipientUser.deviceTokens,
        title,
        body,
        data: { type: "payment_split_received" },
      })
      if (nsResp instanceof NotificationsServiceError) {
        logger.error(nsResp, "split receive push failed")
      }
    }
  } catch (err) {
    logger.error({ err }, "split receive push failed")
  }
}

const sendOnchainNotification = async (
  req: PaymentRequest,
  res: Response,
  next: NextFunction,
) => {
  if (!req.paymentContext) return next()

  const { transaction } = req.body

  const { receiverWallet, recipientAccount, recipientUser } = req.paymentContext

  const usdAmount = USDAmount.dollars(transaction.amount)
  if (usdAmount instanceof Error) {
    logger.error(usdAmount, "Invalid transaction amount")
    return next()
  }

  const nResp = await NotificationsService().onChainTxReceived({
    recipientAccountId: recipientAccount.id,
    recipientWalletId: receiverWallet.id,
    paymentAmount: usdAmount.asPaymentAmount(),
    displayPaymentAmount: await toDisplayAmount(recipientAccount.displayCurrency)(
      transaction.amount,
    ),
    recipientDeviceTokens: recipientUser.deviceTokens,
    recipientNotificationSettings: recipientAccount.notificationSettings,
    recipientLanguage: recipientUser.language,
    txHash: transaction.hash,
  })

  if (nResp instanceof DeviceTokensNotRegisteredNotificationsServiceError) {
    await removeDeviceTokens({ userId: recipientUser.id, deviceTokens: nResp.tokens })
  } else if (nResp instanceof NotificationsServiceError) {
    logger.error(nResp)
  }

  notifyOpsEvent({
    flow: "deposit",
    phase: "succeeded",
    status: "success",
    accountId: recipientAccount.id,
    amount: { value: usdAmount.asDollars(), currency: "USD" },
    meta: { type: "onchain", txHash: transaction.hash },
  })

  next()
}

const sendZapReceipt = async (
  req: PaymentRequest,
  _resp: Response,
  next: NextFunction,
) => {
  if (!req.paymentContext) return next()

  const { transaction } = req.body
  const paymentHash = parsePaymentHash(transaction?.invoice?.hash)
  if (!paymentHash) {
    logger.warn("Skipping zap receipt for invalid payment hash")
    return next()
  }

  const zapRequest = await ZapRequestModel.findOne({ invoiceHash: { $eq: paymentHash } })
  if (!zapRequest) return next()

  try {
    await ZapPublisher.publishFromWebhook({
      zapRequest: JSON.parse(zapRequest.nostrJson),
      amountMsat: zapRequest.amountMsat,
      bolt11: zapRequest.bolt11,
    })
    zapRequest.fulfilled = true
    await zapRequest.save()
  } catch (err) {
    logger.error({ err }, "Failed to publish zap receipt")
  }

  next()
}

// --- Routes ---
const paths = ibexWebhookPaths.onReceive

const router = express.Router()

const webhookRateLimit = rateLimitMiddleware({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
})

const respond200 = (_req: Request, resp: Response) => {
  // Split legs built above are executed in-process, after the response —
  // §2.3: settle → 200 → execute. Internal pays are synchronous (~0.5 s) and
  // the loop retries anything left pending.
  if ((_req as PaymentRequest).paymentContext?.splitReceive) executeSplitLegs()
  resp.status(200).end()
}

router.post(
  paths.invoice,
  webhookRateLimit,
  validateIbexIp,
  authenticate,
  logRequest,
  fetchPaymentContext,
  settleSplitReceive,
  sendLightningNotification,
  sendZapReceipt,
  respond200,
)

router.post(
  paths.lnurl,
  webhookRateLimit,
  validateIbexIp,
  authenticate,
  logRequest,
  fetchPaymentContext,
  settleSplitReceive,
  sendLightningNotification,
  sendZapReceipt,
  respond200,
)

router.post(
  paths.zap,
  webhookRateLimit,
  validateIbexIp,
  authenticate,
  logRequest,
  fetchPaymentContext,
  sendZapReceipt,
  (_req, resp) => resp.status(200).end(),
)

router.post(
  paths.cashout,
  webhookRateLimit,
  validateIbexIp,
  authenticate,
  logRequest,
  (_req, resp) => {
    baseLogger.info("Received payment for cashout.")
    resp.status(200).end()
  },
)

router.post(
  paths.onchain,
  webhookRateLimit,
  validateIbexIp,
  authenticate,
  logRequest,
  fetchPaymentContext,
  sendOnchainNotification,
  (_req, resp) => {
    baseLogger.info("Received onchain payment.")
    resp.status(200).end()
  },
)

export { paths, router }

// --- Helper functions ---
const PaymentHashRegex = /^[0-9a-f]{64}$/i

const parsePaymentHash = (hash: unknown) =>
  typeof hash === "string" && PaymentHashRegex.test(hash) ? hash : undefined

const toPaymentAmount = (currency: WalletCurrency) => (dollarAmount: number) => {
  let amount: PaymentAmount<WalletCurrency>["amount"] | undefined
  if (currency === WalletCurrency.Usd) amount = BigInt(Math.round(dollarAmount * 100))
  if (currency === WalletCurrency.Usdt)
    amount = BigInt(Math.round(dollarAmount * USDT_MICROS_PER_MAJOR_UNIT))
  return { amount: amount as PaymentAmount<WalletCurrency>["amount"], currency }
}

const toDisplayAmount = (currency: DisplayCurrency) => async (sats: number) => {
  const displayCurrencyPrice = await getCurrentPriceAsDisplayPriceRatio({ currency })
  if (displayCurrencyPrice instanceof Error) {
    logger.warn(displayCurrencyPrice, "displayCurrencyPrice")
    return undefined
  }
  return displayCurrencyPrice.convertFromWallet({
    amount: BigInt(Math.round(sats)),
    currency: "BTC",
  })
}
