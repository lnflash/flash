import express, { Request, Response } from "express"
import { IBEX_LISTENER_PORT, IBEX_EXTERNAL_URI, IBEX_WEBHOOK_SECRET } from "@config"
import { baseLogger as logger } from "@services/logger"
import { onPay, onReceive } from "./routes"

const start = () => {
    const app = express()

    // Middleware to parse JSON requests
    app.use(express.json());

    // Routes
    app.get("/health", (_: Request, resp: Response) => resp.send("Ibex server is running"))
    app.use(onReceive.router)
    app.use(onPay.router)
    app.listen(IBEX_LISTENER_PORT, () => logger.info(`Listening for ibex events on port ${IBEX_LISTENER_PORT}. External Uri set to ${IBEX_EXTERNAL_URI}`))
}

export default {
  start, 
  endpoints: {
    onReceive: {
      invoice: IBEX_EXTERNAL_URI + onReceive.paths.invoice,
      lnurl: IBEX_EXTERNAL_URI + onReceive.paths.lnurl,
      onchain: IBEX_EXTERNAL_URI + onReceive.paths.onchain,
    },
    onPay: {
      invoice: IBEX_EXTERNAL_URI + onPay.paths.invoice,
      lnurl: IBEX_EXTERNAL_URI + onPay.paths.lnurl,
      onchain: IBEX_EXTERNAL_URI + onPay.paths.onchain,
    }
  },
  secret: IBEX_WEBHOOK_SECRET,
}



