import express, { Request, Response } from "express"
import { baseLogger as logger } from "@services/logger"
import { NotificationsService } from "@services/notifications"
import { authenticate, logRequest } from "../middleware"
import { AccountsRepository, UsersRepository, WalletsRepository } from "@services/mongoose"
import { RepositoryError } from "@domain/errors"
// import {
//   displayAmountFromWalletAmount,
//   priceAmountFromDisplayPriceRatio,
// } from ""
import { from } from "form-data"
import { getCurrentPriceAsDisplayPriceRatio } from "@app/prices"
import { DisplayAmountsConverter } from "@domain/fiat"

const path = "/invoice/receive"

const router = express.Router() 
router.post(
    path, 
    authenticate,
    logRequest, 
    async (req: Request, resp: Response) => {
        const { transaction } = req.body
        const paymentAmount = transaction.amount
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
            paymentAmount: req.body.transaction.amount,
            displayPaymentAmount: undefined, // DisplayAmount<DisplayCurrency>
            paymentHash: req.body.transaction.invoice.hash,
            recipientDeviceTokens: recipientUser.deviceTokens,
            recipientNotificationSettings: recipientAccount.notificationSettings,
            recipientLanguage: recipientUser.language,
        })       
        if (nsResp instanceof NotificationsService) {
            logger.error(nsResp)
        }
        return resp.status(200).end()
    }
)

export {
    path,
    router,
}