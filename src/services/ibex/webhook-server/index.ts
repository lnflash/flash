import express, { Request, Response } from "express"
import { IbexConfig } from "@config"
import { baseLogger as logger } from "@services/logger"
import { ibexWebhookEndpoints, ibexWebhookSecret } from "@services/ibex/webhook-config"
import { assertStrongSecret } from "@utils/weak-secrets"

import {
  IBEX_WEBHOOK_SECRET_NAME,
  warnIfIbexWebhookRotationSecretsUnusable,
} from "./middleware/authenticate"
import { onPay, onReceive, cryptoReceive } from "./routes"

const start = () => {
  // Fail the rollout, don't log and limp. A weak secret here 503s every
  // /receive/* delivery — settled invoices and on-chain receives stop crediting
  // balances — while /health keeps answering 200, so the first signal anyone
  // gets is missing money hours later. Thrown before anything binds a port; the
  // entrypoint's exitOnBootFailure turns it into a crash-looping pod, which is
  // the visible failure.
  assertStrongSecret(IBEX_WEBHOOK_SECRET_NAME, IbexConfig.webhook.secret)
  // Rotation entries are not fatal (they are optional by definition), but an
  // unusable one silently narrows the window it was added to widen.
  warnIfIbexWebhookRotationSecretsUnusable()

  const app = express()

  // Exactly one XFF-writing hop sits in front of the pod: the nginx ingress
  // (the DO load balancer is L4 and does not touch headers). Trusting that one
  // hop makes req.ip the real sender — per-sender rate-limit buckets and a
  // non-spoofable IP for the `ibex.webhook.allowedIps` allowlist — while
  // entries a client forges into X-Forwarded-For stay untrusted.
  app.set("trust proxy", 1)

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
