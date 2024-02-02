import express, { Request, Response } from "express"
import { baseLogger as log } from "@services/logger"
import { NotificationsService } from "@services/notifications"

export const startServer = () => {
    const app = express()
    const port = 8889

    // Middleware to parse JSON requests
    app.use(express.json());

    // Routes
    app.get("/ibex", sayHi)
    app.post("/invoice/receive/status", authenticate, receiveInvoiceStatus)
    app.post("/invoice/pay/status", authenticate, payInvoiceStatus)
    app.listen(port, () => log.info(`Listening for ibex events on port ${port}!`))
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
