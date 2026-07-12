import { GT } from "@graphql/index"
import ApiKeyScope from "@graphql/public/types/scalar/api-key-scope"
import Timestamp from "@graphql/shared/types/scalar/timestamp"

// Returned by apiKeyCreate and apiKeyRotate — the only two places the raw
// key ever appears
const ApiKeyCreated = GT.Object({
  name: "ApiKeyCreated",
  fields: () => ({
    id: { type: GT.NonNullID },
    keyId: {
      type: GT.NonNull(GT.String),
      description: "Public key identifier (the keyId in fk_<keyId>_<secret>)",
    },
    name: { type: GT.NonNull(GT.String) },
    apiKey: {
      type: GT.NonNull(GT.String),
      description: "The raw API key. Store it securely — it won't be shown again.",
    },
    scopes: { type: GT.NonNullList(ApiKeyScope) },
    expiresAt: { type: Timestamp },
    warning: { type: GT.NonNull(GT.String) },
  }),
})

export default ApiKeyCreated
