import { Scope } from "@domain/api-keys"
import { Request } from "express"
import { ApiKeyService } from "@services/api-keys"

// Using Express Request interface augmentation from global declarations in servers/index.files.d.ts

export interface GraphQLPublicContext {
  domainAccount?: {
    id: string
  }
  user?: {
    id: string
  }
  apiKey?: {
    id: string
    accountId: string
    scopes: Scope[]
  }
}

export const getContextFromRequest = async (
  req: Request,
): Promise<GraphQLPublicContext> => {
  const context: GraphQLPublicContext = {}

  // Add user info if available (existing authentication)
  if (req.user) {
    context.user = {
      id: req.user.id,
    }
  }

  // Add domain account if available (existing authentication)
  if (req.domainAccount) {
    context.domainAccount = {
      id: req.domainAccount.id,
    }
  }

  // Add API key info if available (from middleware)
  if (req.apiKey) {
    context.apiKey = {
      id: req.apiKey.id,
      accountId: req.apiKey.accountId,
      scopes: req.apiKey.scopes,
    }
  }

  return context
}

export const hasScope = (context: GraphQLPublicContext, scope: Scope): boolean => {
  if (!context.apiKey) {
    return false
  }

  return context.apiKey.scopes.some(
    (grantedScope) => ApiKeyService.isScopeAllowed(scope, [grantedScope])
  )
}