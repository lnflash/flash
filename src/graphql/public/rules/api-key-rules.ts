import { rule } from "graphql-shield"
import { GraphQLPublicContext, hasScope } from "../context"
import { Scope } from "@domain/api-keys"

// Rule to check if user is authenticated with an API key
export const isApiKeyAuthenticated = rule({ cache: "contextual" })(
  async (_: any, __: any, ctx: GraphQLPublicContext) => {
    return !!ctx.apiKey || "API key authentication required"
  }
)

// Rule to check if API key has a specific scope
export const hasApiKeyScope = (scope: Scope) =>
  rule({ cache: "contextual" })(async (_: any, __: any, ctx: GraphQLPublicContext) => {
    if (!ctx.apiKey) {
      return "API key authentication required"
    }

    if (!hasScope(ctx, scope)) {
      return `API key is missing required scope: ${scope}`
    }

    return true
  })

// Rule to check if API key belongs to account
export const isApiKeyFromAccount = rule({ cache: "contextual" })(
  async (_: any, __: any, ctx: GraphQLPublicContext) => {
    if (!ctx.apiKey) {
      return "API key authentication required"
    }

    if (!ctx.domainAccount) {
      return true // No account context to validate against
    }

    return ctx.apiKey.accountId === ctx.domainAccount.id || "API key does not belong to this account"
  }
)