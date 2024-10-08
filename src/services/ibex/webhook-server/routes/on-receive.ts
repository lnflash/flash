import express, { Request, Response } from "express"
import { baseLogger as logger } from "@services/logger"
import { NotificationsService } from "@services/notifications"
import { authenticate, logRequest } from "../middleware"
import { AccountsRepository, UsersRepository, WalletsRepository } from "@services/mongoose"
import { RepositoryError } from "@domain/errors"
import { displayAmountFromWalletAmount } from "@domain/fiat"
import { WalletCurrency } from "@domain/shared"
import { NotificationsServiceError } from "@domain/notifications"

const sendLightningNotification = async (req: Request, resp: Response) => {
    const { transaction } = req.body
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

    let amount
    if (receiverWallet.currency === WalletCurrency.Usd) amount = (transaction.amount * 100) as any
    const paymentAmount = { amount, currency: receiverWallet.currency }

    const nsResp = await NotificationsService().lightningTxReceived({
        recipientAccountId: recipientAccountId,
        recipientWalletId,
        paymentAmount,
        displayPaymentAmount: displayAmountFromWalletAmount(paymentAmount),
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