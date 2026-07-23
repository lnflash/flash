import client from "prom-client"

// FIP-07 API key observability counters (ENG-103), registered on the
// prom-client default registry and exposed by the per-pod metrics listener
// (src/servers/api-key-metrics.ts). The increment helpers keep call sites
// free of any prom-client import. They live in the services layer — not
// @servers — so the graphql resolvers, express middlewares, and the check
// handler can all import them without a graphql→servers dependency.

export const API_KEY_VERIFICATION_METRIC = "galoy_api_key_verification_total"
export const API_KEY_RATE_LIMITED_METRIC = "galoy_api_key_rate_limited_total"
export const API_KEY_MANAGEMENT_METRIC = "galoy_api_key_management_total"

const verificationCounter = new client.Counter({
  name: API_KEY_VERIFICATION_METRIC,
  help: "API key verifications at the gateway check endpoint, by result and denial reason",
  labelNames: ["result", "reason"],
})

const rateLimitedCounter = new client.Counter({
  name: API_KEY_RATE_LIMITED_METRIC,
  help: "Requests rejected by the per-API-key request rate limiter",
})

const managementCounter = new client.Counter({
  name: API_KEY_MANAGEMENT_METRIC,
  help: "API key management operations, by operation and result",
  labelNames: ["operation", "result"],
})

type ApiKeyVerificationResult = "success" | "denied"
type ApiKeyManagementOperation = "create" | "revoke" | "rotate" | "list"
type ApiKeyManagementResult = "success" | "failure"

// reason is the denial's error class name; successes normalize to "ok" so
// the label set stays bounded
export const incApiKeyVerification = (
  result: ApiKeyVerificationResult,
  reason?: string,
) => {
  verificationCounter.inc({
    result,
    reason: result === "success" ? "ok" : (reason ?? "unknown"),
  })
}

export const incApiKeyRateLimited = () => {
  rateLimitedCounter.inc()
}

export const incApiKeyManagement = (
  operation: ApiKeyManagementOperation,
  result: ApiKeyManagementResult,
) => {
  managementCounter.inc({ operation, result })
}
