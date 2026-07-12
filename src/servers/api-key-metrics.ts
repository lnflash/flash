import express from "express"
import { register } from "prom-client"

import { API_METRICS_PORT } from "@config"
// Importing these bindings evaluates the metrics module, which registers the
// API key counters on the default registry before the first scrape.
import {
  API_KEY_MANAGEMENT_METRIC,
  API_KEY_RATE_LIMITED_METRIC,
  API_KEY_VERIFICATION_METRIC,
} from "@services/api-keys-metrics"
import { baseLogger } from "@services/logger"

import healthzHandler from "./middlewares/healthz"

const logger = baseLogger.child({ module: "api-key-metrics" })

// Per-pod prometheus listener for the main API process (ENG-103). The
// standalone exporter scrapes ledger-level gauges from its own pod; API key
// verification, rate limiting, and management all happen inside the API pods,
// so their counters must be exposed here. Started from graphql-main-server's
// entrypoint only — the admin/ws/trigger/exporter processes never bind it.
export const startApiKeyMetricsServer = () => {
  const server = express()

  server.get("/metrics", async (_req, res) => {
    res.set("Content-Type", register.contentType)
    res.end(await register.metrics())
  })

  server.get(
    "/healthz",
    healthzHandler({
      checkDbConnectionStatus: true,
      checkRedisStatus: false,
      checkLndsStatus: false,
      checkBriaStatus: false,
    }),
  )

  server.listen(API_METRICS_PORT, () => {
    logger.info(
      {
        metrics: [
          API_KEY_VERIFICATION_METRIC,
          API_KEY_RATE_LIMITED_METRIC,
          API_KEY_MANAGEMENT_METRIC,
        ],
      },
      `Server listening to ${API_METRICS_PORT}, metrics exposed on /metrics endpoint`,
    )
  })
}
