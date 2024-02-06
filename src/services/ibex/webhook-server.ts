import express, { Request, Response } from "express"
import { baseLogger as log } from "@services/logger"
import { NotificationsService } from "@services/notifications"
import { IBEX_LISTENER_HOST, IBEX_LISTENER_PORT } from "@config"

export const EXTERNAL_URI = `http://${IBEX_LISTENER_HOST}:${IBEX_LISTENER_PORT}/` 

export const startServer = () => {
    const app = express()

    // Middleware to parse JSON requests
    app.use(express.json());

    log.info(`HOST = ${IBEX_LISTENER_HOST}`)
    log.info(`PORT = ${IBEX_LISTENER_PORT}`)
    // Routes
    app.get("/ibex", sayHi)
    app.post("/invoice/receive/status", authenticate, receiveInvoiceStatus)
    app.post("/invoice/pay/status", authenticate, payInvoiceStatus)
    app.listen(IBEX_LISTENER_PORT, IBEX_LISTENER_HOST, () => log.info(`Listening for ibex events at http://${IBEX_LISTENER_HOST}:${IBEX_LISTENER_PORT}/!`))
}

const authenticate = (req: Request, resp: Response, next) => {
  if (req.body.webhookSecret !== "secret") return resp.status(401).end("Invalid secret")
  next();
};

const sayHi = (req, resp) => {
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
