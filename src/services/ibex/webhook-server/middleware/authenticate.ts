import { Request, Response, NextFunction } from "express"
import { IbexConfig } from "@config"

export const authenticate = (req: Request, resp: Response, next: NextFunction) => {
  console.log("Authenticating webhook request", req.body.webhookSecret, IbexConfig.webhook.secret)
  if (req.body.webhookSecret !== IbexConfig.webhook.secret) return resp.status(401).end("Invalid secret")
  next();
};