import express, { Request, Response, NextFunction } from "express"
import { baseLogger, baseLogger as logger } from "@services/logger"
import { NotificationsService } from "@services/notifications"
import { authenticate, logRequest } from "../middleware"
import {
  AccountsRepository,
  UsersRepository,
  WalletsRepository,
} from "@services/mongoose"
import { RepositoryError } from "@domain/errors"
import { WalletCurrency } from "@domain/shared"
import {
  DeviceTokensNotRegisteredNotificationsServiceError,
  NotificationsServiceError,
} from "@domain/notifications"
import { getCurrentPriceAsDisplayPriceRatio } from "@app/prices"
import { removeDeviceTokens } from "@app/users/remove-device-tokens"
import { ZapRequestModel } from "@services/mongoose/zap-request"
import { ZapPublisher } from "@services/nostr/zapPublisher"

interface PaymentContext {
  receiverWallet: Wallet
  recipientAccount: Account
  recipientUser: User
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

  const receiverWallet = await WalletsRepository().findById(recipientWalletId)
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
  req.paymentContext = { receiverWallet, recipientAccount, recipientUser }
  next()
}

const sendLightningNotification = async (
  req: PaymentRequest,
  resp: Response,
  next: NextFunction,
) => {
  if (!req.paymentContext) return next()

  const { transaction, receivedMsat } = req.body
  const receivedSat = receivedMsat / 1000
  const { receiverWallet, recipientAccount, recipientUser } = req.paymentContext

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

  next()
}

const sendZapReceipt = async (
  req: PaymentRequest,
  _resp: Response,
  next: NextFunction,
) => {
  if (!req.paymentContext) return next()

  const { transaction } = req.body
  const paymentHash = transaction.invoice.hash

  const zapRequest = await ZapRequestModel.findOne({ invoiceHash: paymentHash })
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
const paths = {
  invoice: "/receive/invoice",
  lnurl: "/receive/lnurlp",
  zap: "/receive/zap",
  onchain: "/receive/onchain",
  cashout: "/receive/cashout",
}

const router = express.Router()

router.post(
  paths.invoice,
  authenticate,
  logRequest,
  fetchPaymentContext,
  sendLightningNotification,
  sendZapReceipt,
  (_req: Request, resp: Response) => resp.status(200).end(),
)

router.post(
  paths.lnurl,
  authenticate,
  logRequest,
  fetchPaymentContext,
  sendLightningNotification,
  sendZapReceipt,
  (_req: Request, resp: Response) => resp.status(200).end(),
)

router.post(
  paths.zap,
  authenticate,
  logRequest,
  fetchPaymentContext,
  sendZapReceipt,
  (_req, resp) => resp.status(200).end(),
)

router.post(paths.cashout, authenticate, logRequest, (_req, resp) => {
  baseLogger.info("Received payment for cashout.")
  resp.status(200).end()
})

router.post(paths.onchain, authenticate, logRequest, (_req, resp) => {
  baseLogger.info("Received onchain payment (not implemented).")
  resp.status(200).end()
})

export { paths, router }

// --- Helper functions ---
const toPaymentAmount = (currency: WalletCurrency) => (dollarAmount: number) => {
  let amount
  if (currency === WalletCurrency.Usd) amount = (dollarAmount * 100) as any
  return { amount, currency }
}

const toDisplayAmount = (currency: DisplayCurrency) => async (sats: number) => {
  const displayCurrencyPrice = await getCurrentPriceAsDisplayPriceRatio({ currency })
  if (displayCurrencyPrice instanceof Error) {
    logger.warn(displayCurrencyPrice, "displayCurrencyPrice")
    return undefined
  }
  return displayCurrencyPrice.convertFromWallet({ amount: BigInt(sats), currency: "BTC" })
}
