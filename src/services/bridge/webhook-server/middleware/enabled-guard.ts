import express from "express"

import { BridgeConfig } from "@config"
import { baseLogger } from "@services/logger"

/**
 * Defense in depth (ENG-466): the chart gates the bridge-webhook workload on
 * galoy.bridge.webhook.enabled, but if the process ever starts with the
 * feature OFF (chart/config drift, a local run, a misconfig) it must not
 * mutate the DB. /health stays up for k8s probes; every other route rejects.
 */
export const bridgeEnabledGuard = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => {
  if (req.path === "/health") return next()
  if (!BridgeConfig.enabled) {
    baseLogger.warn(
      { path: req.path },
      "Bridge webhook received while bridge is disabled — rejecting",
    )
    return res.status(503).json({ error: "Bridge is disabled" })
  }
  return next()
}
