import { Request, Response } from "express"

import { verifyApiKey } from "@app/api-keys"
import { API_KEY_SESSION_PREFIX } from "@domain/api-keys"
import { addAttributesToCurrentSpan } from "@services/tracing"

// Cluster-internal endpoint backing the oathkeeper `bearer_token`
// authenticator for FIP-07 API keys. Oathkeeper forwards the X-API-KEY
// header (via forward_http_headers) and reads the response with
// `subject_from: identity.id`, `extra_from: "@this"` — the same shape as
// kratos whoami, so the existing id_token mutator template applies. A 401
// here surfaces as an explicit 401 at the gateway (same as an invalid
// kratos token); requests without X-API-KEY never reach this endpoint.
export const apiKeyCheckHandler = async (req: Request, res: Response) => {
  const rawKey = req.headers["x-api-key"]
  if (typeof rawKey !== "string" || rawKey.length === 0) {
    return res.status(401).json({ error: "invalid_api_key" })
  }

  const verified = await verifyApiKey(rawKey)
  if (verified instanceof Error) {
    addAttributesToCurrentSpan({ "apiKeys.check.denied": verified.name })
    return res.status(401).json({ error: "invalid_api_key" })
  }

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
  })
}
