import { Request, Response } from "express"

import { verifyApiKey } from "@app/api-keys"
import { getApiKeyConfig } from "@config"
import { parseIps } from "@domain/accounts-ips"
import { API_KEY_SESSION_PREFIX, parseApiKey } from "@domain/api-keys"
import { auditApiKeyDenied } from "@services/api-keys-audit"
import { incApiKeyVerification } from "@services/api-keys-metrics"
import { addAttributesToCurrentSpan } from "@services/tracing"

// Cluster-internal endpoint backing the oathkeeper `bearer_token`
// authenticator for FIP-07 API keys. Oathkeeper forwards the X-API-KEY and
// X-Real-Ip headers (via forward_http_headers) and reads the response with
// `subject_from: identity.id`, `extra_from: "@this"` — the same shape as
// kratos whoami, so the existing id_token mutator template applies. A 401
// here surfaces as an explicit 401 at the gateway (same as an invalid
// kratos token); requests without X-API-KEY never reach this endpoint.
export const apiKeyCheckHandler = async (req: Request, res: Response) => {
  const rawKey = req.headers["x-api-key"]
  if (typeof rawKey !== "string" || rawKey.length === 0) {
    return res.status(401).json({ error: "invalid_api_key" })
  }

  // X-Real-Ip is forced from $remote_addr by the ingress auth-snippet
  // (api-ingress.yaml) so it is the trusted ingress-observed peer, not a
  // client-controlled header, on this oathkeeper auth-subrequest path. If that
  // snippet is ever dropped this becomes spoofable — the IP-constraint control
  // depends on it. verifyApiKey fails closed for IP-constrained keys when it is
  // absent or unparseable.
  const requestIp = parseIps(req.headers["x-real-ip"])
  const verified = await verifyApiKey({ rawKey, requestIp })
  if (verified instanceof Error) {
    addAttributesToCurrentSpan({ "apiKeys.check.denied": verified.name })
    incApiKeyVerification("denied", verified.name)
    // Best-effort public keyId for the audit trail — malformed keys have none
    const parsed = parseApiKey(rawKey)
    auditApiKeyDenied({
      keyId: parsed instanceof Error ? undefined : parsed.keyId,
      reason: verified.name,
      requestIp,
    })
    return res.status(401).json({ error: "invalid_api_key" })
  }

  incApiKeyVerification("success")

  const { apiKey, kratosUserId } = verified
  return res.status(200).json({
    identity: { id: kratosUserId },
    // Surfaces as the `session_id` claim — auditable, and clearly not a
    // kratos session id
    id: `${API_KEY_SESSION_PREFIX}${apiKey.keyId}`,
    // Always empty: key expiry is enforced here on every verification, and
    // a non-empty value would make session.ts try to kratos-extend the
    // fake apikey session id
    expires_at: "",
    // Space-delimited (OAuth style) for the id_token `scope` claim
    scope: apiKey.scopes.join(" "),
    // Numeric `rate_limit` claim — requests/minute for this key. Always
    // present so the gateway-side middleware never needs a DB lookup.
    rate_limit: apiKey.rateLimitPerMinute ?? getApiKeyConfig().defaultRequestsPerMinute,
  })
}
