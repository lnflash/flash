import express, { Request, Response, Router } from "express"
import { TopupConfig } from "@config"
import { baseLogger as logger } from "@services/logger"
import { getAllTopupWebhookHandlers } from "./webhook-handlers"

export const createTopupWebhookRoutes = (): Router => {
  const router = express.Router()
  const handlers = getAllTopupWebhookHandlers()

  for (const handler of handlers) {
    const providerConfig = TopupConfig.providers[handler.provider as keyof typeof TopupConfig.providers]

    if (!providerConfig?.enabled) {
      logger.info({ provider: handler.provider }, "Topup provider webhook disabled")
      continue
    }

    const path = providerConfig.webhook?.path || `/webhooks/topup/${handler.provider}`

    logger.info({ provider: handler.provider, path }, "Registering topup webhook")

    router.post(path, express.json(), async (req: Request, resp: Response) => {
      await handler.handleWebhook(req, resp)
    })
  }

  router.get("/webhooks/topup/health", (_: Request, resp: Response) => {
    const enabledProviders = Object.entries(TopupConfig.providers)
      .filter(([_, config]) => config?.enabled)
      .map(([provider]) => provider)

    resp.json({
      status: "healthy",
      enabledProviders,
    })
  })

  return router
}

export default { createTopupWebhookRoutes }