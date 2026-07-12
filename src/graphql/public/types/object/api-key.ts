import { effectiveApiKeyStatus } from "@domain/api-keys"
import { GT } from "@graphql/index"
import ApiKeyScope from "@graphql/public/types/scalar/api-key-scope"
import ApiKeyStatus from "@graphql/public/types/scalar/api-key-status"
import Timestamp from "@graphql/shared/types/scalar/timestamp"

// Management view of a key — never exposes hashes or secret material
const ApiKeyObject = GT.Object<ApiKey>({
  name: "ApiKey",
  fields: () => ({
    id: { type: GT.NonNullID },
    keyId: {
      type: GT.NonNull(GT.String),
      description: "Public key identifier (the keyId in fk_<keyId>_<secret>)",
    },
    name: { type: GT.NonNull(GT.String) },
    scopes: { type: GT.NonNullList(ApiKeyScope) },
    rateLimitPerMinute: {
      type: GT.Int,
      description:
        "Per-key request rate limit (requests per minute). Null means the platform default applies.",
    },
    status: {
      type: GT.NonNull(ApiKeyStatus),
      description:
        "Effective status: keys past their expiry report EXPIRED even before the stored status catches up",
      resolve: (source) => effectiveApiKeyStatus(source),
    },
    lastUsedAt: { type: Timestamp },
    expiresAt: { type: Timestamp },
    createdAt: { type: GT.NonNull(Timestamp) },
  }),
})

export default ApiKeyObject
