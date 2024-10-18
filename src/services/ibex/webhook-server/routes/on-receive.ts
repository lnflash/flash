import express, { Request, Response } from "express"
import { baseLogger as logger } from "@services/logger"
import { NotificationsService } from "@services/notifications"
import { authenticate, logRequest } from "../middleware"
import { AccountsRepository, UsersRepository, WalletsRepository } from "@services/mongoose"
import { RepositoryError } from "@domain/errors"
import { displayAmountFromWalletAmount } from "@domain/fiat"
import { WalletCurrency } from "@domain/shared"
import { NotificationsServiceError } from "@domain/notifications"
import { getCurrentPriceAsDisplayPriceRatio } from "@app/prices"
import { PriceService } from "@services/price"
import { PriceServiceError } from "@domain/price"

const sendLightningNotification = async (req: Request, resp: Response) => {
    const { transaction, receivedMsat } = req.body
    const receivedSat = receivedMsat / 1000 as Satoshis
    const recipientWalletId = transaction.accountId
   
    const receiverWallet = await WalletsRepository().findById(recipientWalletId)
    if (receiverWallet instanceof RepositoryError) {
        logger.error(receiverWallet, `Failed to fetch wallet with id ${recipientWalletId}`)
        return resp.sendStatus(500)
    }

    const recipientAccountId = receiverWallet.accountId
    const recipientAccount = await AccountsRepository().findById(recipientAccountId)
    if (recipientAccount instanceof Error) {
        logger.error(recipientAccount, `Failed to fetch account with id ${recipientAccountId}`)
        return resp.sendStatus(500)
    }

    const recipientUser = await UsersRepository().findById(recipientAccount.kratosUserId)
    if (recipientUser instanceof Error) {
        logger.error(recipientUser, `Failed to fetch user with kratos id ${recipientAccount.kratosUserId}`)
        return resp.sendStatus(500)
    }


    const nsResp = await NotificationsService().lightningTxReceived({
        recipientAccountId: recipientAccountId,
        recipientWalletId,
        paymentAmount: toPaymentAmount(receiverWallet.currency)(transaction.amount),
        displayPaymentAmount: await toDisplayAmount(recipientAccount.displayCurrency)(receivedSat),
        paymentHash: transaction.invoice.hash,
        recipientDeviceTokens: recipientUser.deviceTokens,
        recipientNotificationSettings: recipientAccount.notificationSettings,
        recipientLanguage: recipientUser.language,
    })       
    if (nsResp instanceof NotificationsServiceError) {
        logger.error(nsResp)
    }
    return resp.status(200).end()
}

const paths = {
    invoice: "/receive/invoice",
    lnurl: "/receive/lnurlp",
    onchain: "/receive/onchain"
}

const router = express.Router() 
router.post(
    paths.invoice, 
    authenticate,
    logRequest, 
    sendLightningNotification
)

router.post(
    paths.lnurl, 
    authenticate,
    logRequest, 
    sendLightningNotification 
)

router.post(
    paths.onchain, 
    authenticate,
    logRequest, 
    // TODO: handleOnchainPayment.  
)

export {
    paths,
    router,
}


const toPaymentAmount = (currency: WalletCurrency) => (dollarAmount: number) => {
    let amount
    if (currency === WalletCurrency.Usd) amount = (dollarAmount * 100) as any
    return { amount, currency }
}

const toDisplayAmount = (currency: DisplayCurrency) => async (sats: Satoshis) => {
    const displayCurrencyPrice = await getCurrentPriceAsDisplayPriceRatio({
      currency: currency,
    })
    if (displayCurrencyPrice instanceof Error) {
        logger.warn(displayCurrencyPrice, "displayCurrencyPrice") // move to otel
        return undefined
    }
    return displayCurrencyPrice.convertFromWallet({ amount: BigInt(sats), currency: "BTC" })  
}
