import { createHash } from "crypto"
// AccountId is a global type from domain/primitives/index.types.d.ts
import { ApiTokenScope, toApiTokenHash } from "@domain/api-tokens/index.types"
import { ApiTokensRepository } from "@services/mongoose/api-tokens"
import { addAttributesToCurrentSpan } from "@services/tracing"
import { getAccount } from "@app/accounts"
import { baseLogger } from "@services/logger"
import { getApiTokenConfig } from "@config"

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
  
  const config = getApiTokenConfig()
  const tokenPrefix = config.tokenPrefix || "flash_"
  
  // Check for API token format: "Bearer <prefix><token>"
  const expectedStart = `Bearer ${tokenPrefix}`
  if (!authHeader?.startsWith(expectedStart)) {
    return null
  }
  
  try {
    // Extract the token (remove "Bearer " and prefix)
    const rawToken = authHeader.substring(expectedStart.length)
    
    
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
    
    // Update last used timestamp asynchronously with single try-catch (best effort)
    (async () => {
      try {
        await apiTokensRepo.updateLastUsed(apiToken.id)
      } catch (err) {
        baseLogger.error(
          { err, apiTokenId: apiToken.id },
          "Failed to update API token last used timestamp"
        )
        addAttributesToCurrentSpan({
          "auth.apiToken.updateLastUsedFailed": true
        })
      }
    })()
    
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
    baseLogger.error(err, "Error validating API token")
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