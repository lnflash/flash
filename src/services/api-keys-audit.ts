import { baseLogger } from "@services/logger"

// Structured audit trail for API key lifecycle and auth events (ENG-104).
// Every entry is info-level, fields-object-first, with a stable `event`
// discriminator for log-based alerting. Only the public keyId ever appears
// here — never the raw key, its secret, or the stored hash.
const auditLogger = baseLogger.child({ module: "api-keys-audit" })

export const auditApiKeyCreated = ({
  accountId,
  keyId,
  scopes,
  expiresAt,
  rateLimitPerMinute,
}: {
  accountId: AccountId
  keyId: ApiKeyKeyId
  scopes: ApiKeyScope[]
  expiresAt: Date | null
  rateLimitPerMinute: number | null
}) => {
  auditLogger.info(
    {
      event: "api_key.created",
      accountId,
      keyId,
      scopes,
      expiresAt,
      rateLimitPerMinute,
    },
    "api key created",
  )
}

export const auditApiKeyRevoked = ({
  accountId,
  keyId,
}: {
  accountId: AccountId
  keyId: ApiKeyKeyId
}) => {
  auditLogger.info({ event: "api_key.revoked", accountId, keyId }, "api key revoked")
}

export const auditApiKeyRotated = ({
  accountId,
  oldKeyId,
  newKeyId,
}: {
  accountId: AccountId
  oldKeyId: ApiKeyKeyId
  newKeyId: ApiKeyKeyId
}) => {
  auditLogger.info(
    { event: "api_key.rotated", accountId, oldKeyId, newKeyId },
    "api key rotated",
  )
}

// keyId is best-effort: denials for malformed keys have no parseable keyId
export const auditApiKeyDenied = ({
  keyId,
  reason,
  requestIp,
}: {
  keyId?: ApiKeyKeyId
  reason: string
  requestIp?: string
}) => {
  auditLogger.info(
    { event: "api_key.denied", keyId, reason, requestIp },
    "api key verification denied",
  )
}

export const auditApiKeyRateLimited = ({ keyId }: { keyId: string }) => {
  auditLogger.info({ event: "api_key.rate_limited", keyId }, "api key rate limited")
}
