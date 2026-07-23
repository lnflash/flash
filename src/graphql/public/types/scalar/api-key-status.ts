import { GT } from "@graphql/index"

const ApiKeyStatus = GT.Enum({
  name: "ApiKeyStatus",
  description: "Lifecycle status of an API key (FIP-07)",
  values: {
    ACTIVE: { value: "active" },
    REVOKED: { value: "revoked" },
    EXPIRED: { value: "expired" },
  },
})

export default ApiKeyStatus
