import crypto from "crypto"

import { Request, Response, NextFunction } from "express"
import { IbexConfig } from "@config"

const timingSafeStringEqual = (actual: unknown, expected: unknown): boolean => {
  if (typeof actual !== "string" || typeof expected !== "string" || expected === "") {
    return false
  }

  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expected)

  return (
    actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  )
}

export const authenticate = (req: Request, resp: Response, next: NextFunction) => {
  if (!timingSafeStringEqual(req.body.webhookSecret, IbexConfig.webhook.secret))
    return resp.status(401).end("Invalid secret")
  next()
}
