import { Request, Response, NextFunction } from "express"
import { baseLogger as logger } from "@services/logger"

export const logRequest = (req: Request, resp: Response, next: NextFunction) => {
    delete req.body.webhookSecret
    logger.info(req.body, "IbexWebhook") // Todo: move this to Honeycomb
    next();
};