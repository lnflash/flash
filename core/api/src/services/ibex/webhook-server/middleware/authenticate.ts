import { Request, Response, NextFunction } from "express"
import { IBEX_WEBHOOK_SECRET } from "@/config"

export const authenticate = (req: Request, resp: Response, next: NextFunction) => {
  if (req.body.webhookSecret !== IBEX_WEBHOOK_SECRET)
    return resp.status(401).end("Invalid secret")
  next()
}
