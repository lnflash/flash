import { GT } from "@graphql/index"

const ApiTokenScope = GT.Enum({
  name: "ApiTokenScope",
  description: "Permission scopes for API tokens",
  values: {
    read: {
      value: "read",
      description: "Read-only access to account data"
    },
    write: {
      value: "write", 
      description: "Read and write access to perform operations"
    },
    admin: {
      value: "admin",
      description: "Full administrative access"
    }
  }
})

export default ApiTokenScope