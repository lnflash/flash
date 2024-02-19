import { Request, Response, NextFunction } from "express"
import { baseLogger as logger } from "@/services/logger"

export const logRequest = (req: Request, resp: Response, next: NextFunction) => {
  logger.info(req.body, "IbexWebhook")
  next()
}
