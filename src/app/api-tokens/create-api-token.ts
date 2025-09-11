import { randomBytes, createHash } from "crypto"
import { 
  CreateApiTokenArgs,
  CreateApiTokenResult,
  ApiTokenScope,
  checkedToApiTokenName,
  toApiTokenHash
} from "@domain/api-tokens/index.types"
import { ApiTokensRepository } from "@services/mongoose/api-tokens"
import { addAttributesToCurrentSpan } from "@services/tracing"
import { DomainError } from "@domain/shared"
import { getApiTokenConfig } from "@config"

export const createApiToken = async ({
  accountId,
  name,
  scopes = ["read"],
  expiresIn = null
}: CreateApiTokenArgs): Promise<CreateApiTokenResult | DomainError> => {
  
  // Add tracing
  addAttributesToCurrentSpan({
    "app.apiTokens.create.accountId": accountId,
    "app.apiTokens.create.name": name,
    "app.apiTokens.create.scopes": scopes.join(","),
    "app.apiTokens.create.expiresIn": expiresIn || undefined
  })
  
  // Validate inputs
  const checkedName = checkedToApiTokenName(name)
  if (checkedName instanceof Error) {
    return checkedName
  }
  
  // Validate scopes
  const validScopes: ApiTokenScope[] = ["read", "write", "admin"]
  for (const scope of scopes) {
    if (!validScopes.includes(scope as ApiTokenScope)) {
      return new DomainError(`Invalid scope: ${scope}`)
    }
  }
  
  // Get configuration
  const config = getApiTokenConfig()
  
  // Check token limit per account (prevent abuse)
  const apiTokensRepo = ApiTokensRepository()
  const existingTokens = await apiTokensRepo.findByAccountId(accountId)
  
  if (!(existingTokens instanceof Error)) {
    const maxTokensPerAccount = config.maxTokensPerAccount || 10
    if (existingTokens.length >= maxTokensPerAccount) {
      return new DomainError(
        `Maximum number of API tokens (${maxTokensPerAccount}) reached. Please revoke unused tokens.`
      )
    }
  }
  
  // Generate secure random token with prefix for easy identification
  const tokenPrefix = config.tokenPrefix || "flash_"
  const rawToken = randomBytes(32).toString('base64url')
  const fullToken = `${tokenPrefix}${rawToken}`
  const tokenHash = createHash('sha256').update(rawToken).digest('hex')
  
  // Calculate expiration date
  const expiresAt = expiresIn 
    ? new Date(Date.now() + expiresIn * 1000)
    : null // Default: no expiration
  
  // Create token in database
  const apiToken = await apiTokensRepo.create({
    accountId,
    name: checkedName,
    tokenHash: toApiTokenHash(tokenHash),
    scopes: scopes as ApiTokenScope[],
    expiresAt
  })
  
  if (apiToken instanceof Error) {
    addAttributesToCurrentSpan({ "app.apiTokens.create.error": true })
    return apiToken
  }
  
  addAttributesToCurrentSpan({ 
    "app.apiTokens.create.success": true,
    "app.apiTokens.create.tokenId": apiToken.id 
  })
  
  // Return token only once (won't be stored in plain text)
  return {
    id: apiToken.id,
    name: apiToken.name,
    token: fullToken, // Full token with prefix
    scopes: apiToken.scopes,
    expiresAt: apiToken.expiresAt,
    warning: "Store this token securely. It won't be shown again."
  }
}