import express, { Request, Response } from "express"
import { IbexConfig } from "@config"
import { baseLogger as logger } from "@services/logger"
import { ibexWebhookEndpoints, ibexWebhookSecret } from "@services/ibex/webhook-config"

import { onPay, onReceive, cryptoReceive } from "./routes"

const start = () => {
  const app = express()

  app.use(express.json())

  app.get("/health", (_: Request, resp: Response) => resp.send("Ibex server is running"))
  app.use(onReceive.router)
  app.use(onPay.router)
  app.use(cryptoReceive.router)
  app.listen(IbexConfig.webhook.port, () =>
    logger.info(
      `Listening for ibex events on port ${IbexConfig.webhook.port}. Can be reached at ${IbexConfig.webhook.uri}`,
    ),
  )
}

export default {
  start,
  endpoints: ibexWebhookEndpoints,
  secret: ibexWebhookSecret,
}
