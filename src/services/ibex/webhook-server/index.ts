import express, { Request, Response } from "express"
import { IbexConfig } from "@config"
import { baseLogger as logger } from "@services/logger"
import { onPay, onReceive } from "./routes"
import { createTopupWebhookRoutes } from "@services/topup/webhook-server"

const start = () => {
    const app = express()

    // Middleware to parse JSON requests
    app.use(express.json());

    // Routes
    app.get("/health", (_: Request, resp: Response) => resp.send("Webhook server is running"))

    // Ibex webhook routes
    app.use(onReceive.router)
    app.use(onPay.router)

    // Topup webhook routes
    app.use(createTopupWebhookRoutes())

    app.listen(IbexConfig.webhook.port, () => logger.info(`Listening for webhook events on port ${IbexConfig.webhook.port}. Can be reached at ${IbexConfig.webhook.uri}`))
}

export default {
  start, 
  endpoints: {
    onReceive: {
      invoice: IbexConfig.webhook.uri + onReceive.paths.invoice,
      lnurl: IbexConfig.webhook.uri + onReceive.paths.lnurl,
      onchain: IbexConfig.webhook.uri + onReceive.paths.onchain,
      cashout: IbexConfig.webhook.uri + onReceive.paths.cashout,
    },
    onPay: {
      invoice: IbexConfig.webhook.uri + onPay.paths.invoice,
      lnurl: IbexConfig.webhook.uri + onPay.paths.lnurl,
      onchain: IbexConfig.webhook.uri + onPay.paths.onchain,
    }
  },
  secret: IbexConfig.webhook.secret,
}



