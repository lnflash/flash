import { createHash } from "crypto"
// AccountId is a global type from domain/primitives/index.types.d.ts
import { ApiTokenScope, toApiTokenHash } from "@domain/api-tokens/index.types"
import { ApiTokensRepository } from "@services/mongoose/api-tokens"
import { addAttributesToCurrentSpan } from "@services/tracing"
import { getAccount } from "@app/accounts"

export interface ApiTokenAuth {
  accountId: AccountId
  scopes: ApiTokenScope[]
  tokenId: string
}

/**
 * Validates an API token from the Authorization header
 * Returns account information if valid, null otherwise
 */
export const validateApiToken = async (
  authHeader: string | undefined
): Promise<ApiTokenAuth | null> => {
  
  // Check for Flash API token format: "Bearer flash_<token>"
  if (!authHeader?.startsWith('Bearer flash_')) {
    return null
  }
  
  try {
    // Extract the token (remove "Bearer flash_" prefix)
    const fullToken = authHeader.substring(7) // Remove "Bearer "
    const rawToken = fullToken.substring(6) // Remove "flash_" prefix
    
    // Hash the token for database lookup
    const tokenHash = createHash('sha256').update(rawToken).digest('hex')
    
    addAttributesToCurrentSpan({
      "auth.apiToken.attempt": true,
      "auth.apiToken.hashPrefix": tokenHash.substring(0, 8) // Log prefix only for debugging
    })
    
    // Look up token in database
    const apiTokensRepo = ApiTokensRepository()
    const apiToken = await apiTokensRepo.findByTokenHash(toApiTokenHash(tokenHash))
    
    // Check if token exists and is valid
    if (apiToken instanceof Error) {
      addAttributesToCurrentSpan({ 
        "auth.apiToken.notFound": true 
      })
      return null
    }
    
    // Check if token is active
    if (!apiToken.active) {
      addAttributesToCurrentSpan({ 
        "auth.apiToken.inactive": true 
      })
      return null
    }
    
    // Check if token has expired
    if (apiToken.expiresAt && apiToken.expiresAt < new Date()) {
      addAttributesToCurrentSpan({ 
        "auth.apiToken.expired": true 
      })
      return null
    }
    
    // Update last used timestamp asynchronously (don't wait for it)
    apiTokensRepo.updateLastUsed(apiToken.id).catch((err) => {
      console.error("Failed to update API token last used timestamp:", err)
    })
    
    addAttributesToCurrentSpan({
      "auth.apiToken.success": true,
      "auth.apiToken.accountId": apiToken.accountId,
      "auth.apiToken.scopes": apiToken.scopes.join(","),
      "auth.apiToken.tokenId": apiToken.id
    })
    
    return {
      accountId: apiToken.accountId,
      scopes: apiToken.scopes,
      tokenId: apiToken.id
    }
  } catch (err) {
    console.error("Error validating API token:", err)
    addAttributesToCurrentSpan({ 
      "auth.apiToken.error": true,
      "auth.apiToken.errorMessage": err instanceof Error ? err.message : "Unknown error"
    })
    return null
  }
}

/**
 * Check if the API token has the required scope for an operation
 */
export const hasApiTokenScope = (
  scopes: ApiTokenScope[],
  requiredScope: ApiTokenScope
): boolean => {
  // Admin scope has access to everything
  if (scopes.includes("admin")) {
    return true
  }
  
  // Write scope includes read permissions
  if (requiredScope === "read" && scopes.includes("write")) {
    return true
  }
  
  // Check for exact scope match
  return scopes.includes(requiredScope)
}

/**
 * Get account context from API token authentication
 */
export const getApiTokenAccountContext = async (
  auth: ApiTokenAuth
) => {
  const account = await getAccount(auth.accountId)
  
  if (account instanceof Error) {
    addAttributesToCurrentSpan({ 
      "auth.apiToken.accountNotFound": true 
    })
    return null
  }
  
  return {
    domainAccount: account,
    isApiToken: true,
    apiTokenScopes: auth.scopes,
    apiTokenId: auth.tokenId
  }
}