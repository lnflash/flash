# API Token Generation Implementation Plan

## Overview
Add API token generation and authentication to Flash backend while maintaining existing Ory Kratos session authentication. This allows external services (like BTCPayServer Flash plugin) to authenticate without Ory sessions.

## Architecture Alignment
- Follows existing repository pattern
- Uses domain/application/service layer separation  
- Maintains GraphQL resolver patterns
- Extends current authentication middleware
- Preserves backward compatibility

---

## Phase 1: MVP Implementation (1-2 days)

### 1.1 Domain Layer
**File: `src/domain/api-tokens/index.types.ts`**
```typescript
export type ApiTokenId = string & { readonly brand: unique symbol }
export type ApiToken = string & { readonly brand: unique symbol }
export type ApiTokenName = string & { readonly brand: unique symbol }

export type ApiTokenScope = "read" | "write" | "admin"

export interface IApiToken {
  id: ApiTokenId
  accountId: AccountId
  name: ApiTokenName
  token: ApiToken
  scopes: ApiTokenScope[]
  lastUsed: Date | null
  createdAt: Date
  expiresAt: Date | null
  active: boolean
}
```

### 1.2 MongoDB Schema
**File: `src/services/mongoose/api-tokens.ts`**
```typescript
const ApiTokenSchema = new Schema({
  _id: { type: Schema.Types.ObjectId, auto: true },
  accountId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  tokenHash: { type: String, required: true, unique: true, index: true }, // SHA256 hash
  scopes: [{ type: String, enum: ["read", "write", "admin"] }],
  lastUsed: { type: Date, default: null },
  expiresAt: { type: Date, default: null },
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
})

// Repository interface following existing pattern
export interface IApiTokensRepository {
  create(token: NewApiToken): Promise<ApiToken | RepositoryError>
  findByTokenHash(hash: string): Promise<ApiToken | RepositoryError>
  findByAccountId(accountId: AccountId): Promise<ApiToken[] | RepositoryError>
  updateLastUsed(id: ApiTokenId): Promise<void | RepositoryError>
  revoke(id: ApiTokenId): Promise<ApiToken | RepositoryError>
}
```

### 1.3 Application Layer
**File: `src/app/api-tokens/create-api-token.ts`**
```typescript
import { randomBytes, createHash } from 'crypto'

export const createApiToken = async ({
  accountId,
  name,
  scopes = ["read"],
  expiresIn = null
}: CreateApiTokenArgs): Promise<CreateApiTokenResult | ApplicationError> => {
  
  // Validate inputs
  const checkedName = checkedToApiTokenName(name)
  if (checkedName instanceof Error) return checkedName
  
  // Generate secure random token
  const rawToken = randomBytes(32).toString('base64url')
  const tokenHash = createHash('sha256').update(rawToken).digest('hex')
  
  // Create token in database
  const apiTokensRepo = ApiTokensRepository()
  const apiToken = await apiTokensRepo.create({
    accountId,
    name: checkedName,
    tokenHash,
    scopes,
    expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null
  })
  
  if (apiToken instanceof Error) return apiToken
  
  // Return token only once (won't be stored in plain text)
  return {
    id: apiToken.id,
    name: apiToken.name,
    token: `flash_${rawToken}`, // Prefixed for easy identification
    scopes: apiToken.scopes,
    expiresAt: apiToken.expiresAt
  }
}
```

### 1.4 Authentication Middleware Extension
**File: `src/servers/middlewares/api-token-auth.ts`**
```typescript
export const validateApiToken = async (
  authHeader: string | undefined
): Promise<{ accountId: AccountId, scopes: ApiTokenScope[] } | null> => {
  
  if (!authHeader?.startsWith('Bearer flash_')) return null
  
  const token = authHeader.substring(13) // Remove "Bearer flash_" prefix
  const tokenHash = createHash('sha256').update(token).digest('hex')
  
  const apiTokensRepo = ApiTokensRepository()
  const apiToken = await apiTokensRepo.findByTokenHash(tokenHash)
  
  if (apiToken instanceof Error) return null
  if (!apiToken.active) return null
  if (apiToken.expiresAt && apiToken.expiresAt < new Date()) return null
  
  // Update last used timestamp asynchronously
  apiTokensRepo.updateLastUsed(apiToken.id).catch(console.error)
  
  return {
    accountId: apiToken.accountId,
    scopes: apiToken.scopes
  }
}
```

**Update: `src/servers/middlewares/session.ts`**
```typescript
// Add to sessionPublicContext function
export const sessionPublicContext = async (req: Request): Promise<GraphQLPublicContext> => {
  // Try API token first
  const apiTokenAuth = await validateApiToken(req.headers.authorization)
  if (apiTokenAuth) {
    const account = await Accounts.getAccount(apiTokenAuth.accountId)
    if (!(account instanceof Error)) {
      return {
        domainAccount: account,
        isApiToken: true,
        apiTokenScopes: apiTokenAuth.scopes
      }
    }
  }
  
  // Fall back to existing Kratos session validation
  // ... existing code ...
}
```

### 1.5 GraphQL Mutations (MVP)
**File: `src/graphql/public/root/mutation/api-token-create.ts`**
```typescript
const ApiTokenCreateInput = GT.Input({
  name: "ApiTokenCreateInput",
  fields: () => ({
    name: { type: GT.NonNull(GT.String) },
    scopes: { 
      type: GT.List(GT.NonNull(ApiTokenScope)), 
      defaultValue: ["read"] 
    }
  })
})

const ApiTokenCreateMutation = GT.Field({
  extensions: { complexity: 120 },
  type: GT.NonNull(ApiTokenCreatePayload),
  description: "Generate a new API token for external service authentication",
  args: {
    input: { type: GT.NonNull(ApiTokenCreateInput) }
  },
  resolve: async (_, args, { domainAccount }: GraphQLPublicContextAuth) => {
    const result = await ApiTokens.createApiToken({
      accountId: domainAccount.id,
      name: args.input.name,
      scopes: args.input.scopes
    })
    
    if (result instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(result)] }
    }
    
    return {
      errors: [],
      apiToken: {
        ...result,
        token: result.token, // Only returned on creation
        warning: "Store this token securely. It won't be shown again."
      }
    }
  }
})
```

---

## Phase 2: Full Implementation (3-5 days)

### 2.1 Enhanced Token Management

**Additional GraphQL Operations:**
```typescript
// List tokens (without exposing actual token values)
ApiTokensListQuery
// Revoke a token
ApiTokenRevokeMutation  
// Update token scopes
ApiTokenUpdateScopesMutation
// Rotate token (revoke old, create new)
ApiTokenRotateMutation
```

### 2.2 Token Scopes and Permissions
```typescript
export enum ApiTokenScope {
  // Read operations
  READ_BALANCE = "read:balance",
  READ_TRANSACTIONS = "read:transactions",
  READ_INVOICES = "read:invoices",
  
  // Write operations  
  WRITE_INVOICE = "write:invoice",
  WRITE_PAYMENT = "write:payment",
  WRITE_WITHDRAWAL = "write:withdrawal",
  
  // Admin operations
  ADMIN_SETTINGS = "admin:settings",
  ADMIN_TOKENS = "admin:tokens"
}
```

### 2.3 Rate Limiting for API Tokens
**File: `src/servers/middlewares/rate-limit.ts`**
```typescript
export const apiTokenRateLimiter = RateLimiterRedis({
  keyPrefix: 'api_token_rl',
  points: 100, // requests
  duration: 60, // per minute
  blockDuration: 60 * 5 // 5 minute block
})

// Apply stricter limits for write operations
export const apiTokenWriteRateLimiter = RateLimiterRedis({
  keyPrefix: 'api_token_write_rl',
  points: 20,
  duration: 60,
  blockDuration: 60 * 15
})
```

### 2.4 Token Usage Analytics
```typescript
interface ApiTokenUsageMetrics {
  tokenId: ApiTokenId
  endpoint: string
  timestamp: Date
  responseTime: number
  statusCode: number
  ipAddress: string
}

// Track in MongoDB for usage analytics
const ApiTokenUsageSchema = new Schema({
  tokenId: { type: String, required: true, index: true },
  endpoint: String,
  timestamp: { type: Date, default: Date.now, index: true },
  responseTime: Number,
  statusCode: Number,
  ipAddress: String
})
```

### 2.5 Security Enhancements

**Token Rotation Policy:**
```typescript
export const enforceTokenRotation = async (
  token: IApiToken
): Promise<boolean> => {
  const MAX_TOKEN_AGE_DAYS = 90
  const tokenAge = Date.now() - token.createdAt.getTime()
  
  if (tokenAge > MAX_TOKEN_AGE_DAYS * 24 * 60 * 60 * 1000) {
    // Send notification to rotate token
    await Notifications.sendTokenRotationReminder(token.accountId)
    return true
  }
  return false
}
```

**IP Restriction (Optional):**
```typescript
interface ApiTokenIpRestriction {
  tokenId: ApiTokenId
  allowedIps: string[]
  restrictionEnabled: boolean
}
```

### 2.6 Admin Dashboard Integration
- Add UI components for token management
- Display token usage statistics
- Token audit logs
- Automatic cleanup of expired tokens

### 2.7 Migration and Backward Compatibility
```typescript
// Ensure existing authentication continues to work
export const authenticationMiddleware = async (req: Request) => {
  // 1. Check for API token
  const apiToken = await checkApiToken(req.headers.authorization)
  if (apiToken) return apiToken
  
  // 2. Check for Kratos session (existing)
  const kratosSession = await checkKratosSession(req)
  if (kratosSession) return kratosSession
  
  // 3. Return unauthorized
  throw new UnauthorizedError()
}
```

---

## Implementation Timeline

### Week 1: MVP
- **Day 1**: Domain models, MongoDB schema, repository
- **Day 2**: Application layer, token generation logic
- **Day 3**: Authentication middleware integration
- **Day 4**: GraphQL mutations, testing
- **Day 5**: Integration with BTCPayServer plugin

### Week 2: Full Implementation  
- **Days 6-7**: Enhanced token management operations
- **Days 8-9**: Scopes, permissions, rate limiting
- **Day 10**: Usage analytics, security enhancements
- **Days 11-12**: Testing, documentation, deployment

---

## Testing Strategy

### Unit Tests
```typescript
describe("ApiTokens", () => {
  describe("createApiToken", () => {
    it("generates unique secure tokens", async () => {})
    it("correctly hashes tokens for storage", async () => {})
    it("enforces scope restrictions", async () => {})
  })
  
  describe("validateApiToken", () => {
    it("validates token format", async () => {})
    it("checks expiration", async () => {})
    it("updates last used timestamp", async () => {})
  })
})
```

### Integration Tests
- Test with BTCPayServer Flash plugin
- Verify GraphQL operations work with API tokens
- Ensure Kratos session auth still works
- Test rate limiting behavior

---

## Deployment Considerations

1. **Database Migration**: Add indexes for token lookups
2. **Environment Variables**: Add token encryption keys
3. **Monitoring**: Add metrics for API token usage
4. **Documentation**: Update API docs with token auth
5. **Security**: Regular token rotation reminders

---

## Success Criteria

### MVP Success
- [ ] API tokens can be generated via GraphQL
- [ ] Tokens authenticate GraphQL requests
- [ ] BTCPayServer plugin works with tokens
- [ ] Existing auth still works

### Full Implementation Success  
- [ ] Complete token lifecycle management
- [ ] Granular permission scopes
- [ ] Usage analytics and monitoring
- [ ] Security best practices implemented
- [ ] Comprehensive test coverage

---

## Notes for BTCPayServer Integration

Once API tokens are implemented, the Flash plugin can:
1. Exchange Ory session for API token (one-time)
2. Store API token securely
3. Use API token for all GraphQL operations
4. Handle token rotation when needed

This solves the current authentication issue while maintaining security and following Flash backend patterns.