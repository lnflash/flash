import express, { NextFunction, Request, Response } from "express"
import { baseLogger as log } from "@services/logger"
import { NotificationsService } from "@services/notifications"
import { IBEX_LISTENER_HOST, IBEX_LISTENER_PORT, IBEX_WEBHOOK_SECRET } from "@config"

const WEBHOOK_URI = `http://${IBEX_LISTENER_HOST}:${IBEX_LISTENER_PORT}/` 
const RECEIVE_PAYMENT_URL_PATH = "/invoice/receive/status"
const SENT_PAYMENT_URL_PATH = "/invoice/pay/status"

export const RECEIVE_PAYMENT_URL = WEBHOOK_URI + RECEIVE_PAYMENT_URL_PATH
export const SENT_PAYMENT_URL = WEBHOOK_URI + SENT_PAYMENT_URL_PATH
export const WEBHOOK_SECRET = IBEX_WEBHOOK_SECRET

export const startServer = () => {
    const app = express()

    // Middleware to parse JSON requests
    app.use(express.json());

    // Routes
    app.get("/ibex/health", healthCheck)
    app.post(RECEIVE_PAYMENT_URL_PATH, authenticate, receiveInvoiceStatus)
    app.post(SENT_PAYMENT_URL_PATH, authenticate, payInvoiceStatus)
    app.listen(IBEX_LISTENER_PORT, IBEX_LISTENER_HOST, () => log.info(`Listening for ibex events at http://${IBEX_LISTENER_HOST}:${IBEX_LISTENER_PORT}/!`))
}

const authenticate = (req: Request, resp: Response, next: NextFunction) => {
  if (req.body.webhookSecret !== "secret") return resp.status(401).end("Invalid secret")
  next();
};

const healthCheck = (req: Request, resp: Response) => {
    log.info("Ibex Server: Hello")
    resp.send("Ibex server is running")
}

const receiveInvoiceStatus = async (req: Request, resp: Response) => {
    const { transaction } = req.body
    log.info("Ibex webhook: Transaction received", { id: transaction.id })
    const nsResp = await NotificationsService().ibexTxReceived({paymentHash: transaction.invoice.hash})
    if (nsResp instanceof NotificationsService) {
      log.error(nsResp)
      // return resp.status(500).end()
    }
    return resp.status(200).end()
}

const payInvoiceStatus = async (req: Request, resp: Response) => {
    const { transaction, status } = req.body
    log.info("Ibex webhook: Payment status update", { id: transaction.id, status: status.name })
    // const nsResp = await NotificationsService().ibexTxReceived({paymentHash: transaction.payment.hash})
    // if (nsResp instanceof NotificationsService) {
    //   log.error(nsResp)
    //   return resp.status(500).end()
    // }
    return resp.status(200).end()
}
