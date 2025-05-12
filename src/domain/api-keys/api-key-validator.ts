import { ApiKeyIdRegex, ApiKeyStatus, ApiKeyType, API_KEY_PREFIX, API_KEY_PREFIX_SEPARATOR, isValidScope, Scope } from "."

// Validates an API key format
export const validateApiKeyFormat = (apiKey: string): { valid: boolean; type?: ApiKeyType } => {
  if (!apiKey) {
    return { valid: false }
  }

  // Check if it starts with a valid prefix
  const prefixMatch = Object.entries(API_KEY_PREFIX).find(([_, prefix]) =>
    apiKey.startsWith(`${prefix}${API_KEY_PREFIX_SEPARATOR}`)
  )

  if (!prefixMatch) {
    return { valid: false }
  }

  const [type] = prefixMatch
  const keyType = type as ApiKeyType

  // Check the overall format and length
  // Expecting format: flash_(test|live)_randomBytes
  const keyParts = apiKey.split(API_KEY_PREFIX_SEPARATOR)
  if (keyParts.length !== 2) {
    return { valid: false }
  }

  const randomPart = keyParts[1]
  // Ensure sufficient entropy - at least 32 bytes (no strict length check)
  if (randomPart.length < 32) {
    return { valid: false }
  }

  return { valid: true, type: keyType }
}

// Validates an ID has the correct format for an API key ID
export const validateApiKeyId = (id: string): boolean => {
  return ApiKeyIdRegex.test(id)
}

// Validates a list of scopes
export const validateScopes = (scopes: string[]): { valid: boolean; invalidScopes: string[] } => {
  if (!scopes || !Array.isArray(scopes) || scopes.length === 0) {
    return { valid: false, invalidScopes: [] }
  }

  const invalidScopes = scopes.filter((scope) => !isValidScope(scope))
  
  return {
    valid: invalidScopes.length === 0,
    invalidScopes,
  }
}

// Checks if a scope is allowed within a list of granted scopes
export const isScopeAllowed = (requestedScope: string, grantedScopes: Scope[]): boolean => {
  // If the scope is not valid, it's not allowed
  if (!isValidScope(requestedScope)) {
    return false
  }

  const [requestedType, requestedResource, requestedPath] = requestedScope.split(":")
  
  // Check if any granted scope allows the requested scope
  return grantedScopes.some((grantedScope) => {
    const [grantedType, grantedResource, grantedPath] = grantedScope.split(":")
    
    // If "all" is granted, it allows both read and write
    if (grantedType === "all" && (requestedType === "read" || requestedType === "write")) {
      // If the resource matches exactly or the granted resource is "all"
      if (grantedResource === requestedResource || grantedResource === "all") {
        // If no specific path is requested or if the paths match
        if (!requestedPath || !grantedPath || grantedPath === requestedPath) {
          return true
        }
      }
      return false
    }
    
    // Otherwise, types must match exactly
    if (grantedType !== requestedType) {
      return false
    }
    
    // Resource must match or granted resource is "all"
    if (grantedResource !== requestedResource && grantedResource !== "all") {
      return false
    }
    
    // If no specific path is requested or if the paths match
    if (!requestedPath || !grantedPath || grantedPath === requestedPath) {
      return true
    }
    
    return false
  })
}

// Validates the status of an API key
export const isApiKeyActive = (status: ApiKeyStatus): boolean => {
  return status === ApiKeyStatus.Active || status === ApiKeyStatus.Rotating
}

// Validates the expiration of an API key
export const isApiKeyExpired = (expiresAt: Date | null): boolean => {
  if (!expiresAt) {
    return false
  }
  
  return expiresAt.getTime() < Date.now()
}