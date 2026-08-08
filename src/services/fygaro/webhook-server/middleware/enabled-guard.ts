import express from "express"

import { FygaroConfig } from "@config"
import { baseLogger } from "@services/logger"

/**
 * Defense in depth (mirrors the bridge webhook's ENG-466 guard): the chart
 * gates the fygaro-webhook workload on its own enabled flag, but if the
 * process ever starts with the feature OFF (chart/config drift, a local run,
 * a misconfig) it must not mutate the DB. /health stays up for k8s probes;
 * every other route rejects.
 */
export const fygaroEnabledGuard = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => {
  if (req.path === "/health") return next()
  // Optional-chained: if the fygaro config block is ever absent (schema
  // default not applied on some load path), fail closed with the 503 rather
  // than throwing a per-request 500.
  if (!FygaroConfig?.enabled) {
    baseLogger.warn(
      { path: req.path },
      "Fygaro webhook received while fygaro is disabled — rejecting",
    )
    return res.status(503).json({ error: "Fygaro is disabled" })
  }
  return next()
}
