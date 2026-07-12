import { GT } from "@graphql/index"

// FIP-07 fine-grained scopes. GraphQL enum names can't contain ":",
// so the names use "_" while the serialized values keep the FIP-07 form.
const ApiKeyScope = GT.Enum({
  name: "ApiKeyScope",
  description: "Permission scopes for API keys (FIP-07)",
  values: {
    read_wallet: {
      value: "read:wallet",
      description: "Read wallet balances and details",
    },
    write_wallet: {
      value: "write:wallet",
      description: "Perform wallet operations (send/receive)",
    },
    read_transactions: {
      value: "read:transactions",
      description: "Read transaction history",
    },
    write_transactions: {
      value: "write:transactions",
      description: "Create transactions",
    },
    read_user: {
      value: "read:user",
      description: "Read-only access to user/account data",
    },
    write_user: {
      value: "write:user",
      description: "Modify user/account data",
    },
    admin: {
      value: "admin",
      description: "Full administrative access",
    },
  },
})

export default ApiKeyScope
