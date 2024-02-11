import express, { Request, Response } from "express"
import { baseLogger as logger } from "@services/logger"
import { NotificationsService } from "@services/notifications"
import { authenticate, logRequest } from "../middleware"

const path = "/invoice/receive"

const router = express.Router() 
router.post(
    path, 
    authenticate,
    logRequest, 
    async (req: Request, resp: Response) => {
        const { transaction } = req.body
        const nsResp = await NotificationsService().ibexTxReceived({paymentHash: transaction.invoice.hash})
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