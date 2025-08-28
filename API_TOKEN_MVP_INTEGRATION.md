# API Token MVP Integration Guide

## Overview
This guide explains how to integrate API token authentication into the Flash backend to solve the BTCPayServer plugin authentication issue.

## Files Created for MVP

### 1. Domain Layer
- `src/domain/api-tokens/index.types.ts` - Type definitions and validation

### 2. Repository Layer  
- `src/services/mongoose/api-tokens.ts` - MongoDB schema and repository

### 3. Application Layer
- `src/app/api-tokens/create-api-token.ts` - Token generation logic

### 4. Middleware
- `src/servers/middlewares/api-token-auth.ts` - Token validation

### 5. GraphQL
- `src/graphql/public/root/mutation/api-token-create.ts` - Create token mutation
- `src/graphql/public/types/scalar/api-token-scope.ts` - Scope enum type

### 6. Session Integration
- `src/servers/middlewares/session.patch` - Patch file for session middleware

## Integration Steps

### Step 1: Apply the Session Middleware Patch
```bash
cd /Users/dread/Documents/Island-Bitcoin/Flash/claude/flash-backend
patch -p1 < src/servers/middlewares/session.patch
```

### Step 2: Update GraphQL Context Types
Add to `src/graphql/public/types.ts`:
```typescript
import { ApiTokenScope } from "@/domain/api-tokens"

export interface GraphQLPublicContext {
  // ... existing fields ...
  isApiToken?: boolean
  apiTokenScopes?: ApiTokenScope[]
  apiTokenId?: string
}
```

### Step 3: Register the New Mutation
Add to `src/graphql/public/root/mutation/index.ts`:
```typescript
import ApiTokenCreateMutation from "./api-token-create"

// In the mutations object:
export const mutations = {
  // ... existing mutations ...
  apiTokenCreate: ApiTokenCreateMutation,
}
```

### Step 4: Export Application Functions
Add to `src/app/index.ts`:
```typescript
export * as ApiTokens from "./api-tokens"
```

### Step 5: Update Main Server Middleware
In `src/servers/graphql-main-server.ts`, update the context creation:
```typescript
const contextFunction = async ({ req }: { req: Request }): Promise<GraphQLPublicContext> => {
  // Pass Authorization header to session context
  const authHeader = req.headers.authorization
  
  // ... existing code to extract tokenPayload ...
  
  return sessionPublicContext({
    tokenPayload,
    ip,
    authHeader // Add this
  })
}
```

## Testing the Implementation

### 1. Start the Flash Backend
```bash
cd flash-backend
make start-deps  # Start MongoDB, Redis, etc.
make start       # Start the server
```

### 2. Create an API Token via GraphQL
```graphql
mutation CreateApiToken {
  apiTokenCreate(input: {
    name: "BTCPayServer Integration"
    scopes: ["read", "write"]
    expiresIn: 31536000  # 1 year in seconds
  }) {
    errors {
      message
    }
    apiToken {
      id
      name
      token  # Save this! Only shown once
      scopes
      expiresAt
      warning
    }
  }
}
```

### 3. Test Token Authentication
```bash
# Test with the created token
curl -X POST https://api.test.flashapp.me/graphql \
  -H "Authorization: Bearer flash_<your-token-here>" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "mutation { lnInvoiceCreate(input: { amount: 100, memo: \"Test\" }) { invoice { paymentRequest } errors { message } } }"
  }'
```

### 4. Update BTCPayServer Plugin
In the Flash plugin, update the authentication to:
1. First time: Use Ory session to create an API token via GraphQL
2. Store the API token securely
3. Use the API token for all subsequent requests

Example code for the plugin:
```csharp
// One-time token generation (using existing WebSocket with Ory token)
var createTokenMutation = @"
  mutation {
    apiTokenCreate(input: {
      name: ""BTCPayServer Plugin""
      scopes: [""read"", ""write""]
    }) {
      apiToken { token }
      errors { message }
    }
  }";

// Store the returned token securely
var apiToken = response.data.apiTokenCreate.apiToken.token;

// Use for all HTTP requests
httpClient.DefaultRequestHeaders.Authorization = 
    new AuthenticationHeaderValue("Bearer", apiToken);
```

## Security Considerations

1. **Token Storage**: Store tokens securely (encrypted in database/config)
2. **Token Rotation**: Implement token rotation every 90 days
3. **Scope Enforcement**: Always check scopes before operations
4. **Rate Limiting**: Apply stricter limits to API token requests
5. **Audit Logging**: Log all API token usage for security monitoring

## Next Steps for Full Implementation

1. **Additional Mutations**:
   - `apiTokensList` - List all tokens for an account
   - `apiTokenRevoke` - Revoke a specific token
   - `apiTokenRotate` - Rotate token (revoke old, create new)

2. **Enhanced Security**:
   - IP restriction per token
   - More granular scopes
   - Token usage analytics

3. **Admin Features**:
   - Token management UI
   - Usage statistics dashboard
   - Automatic cleanup of expired tokens

## Troubleshooting

### Token Not Working
1. Check token format: Must start with `flash_`
2. Verify token hasn't expired
3. Ensure token is active (not revoked)
4. Check MongoDB for the token hash

### Permission Denied
1. Verify token has required scopes
2. Check GraphQL Shield rules
3. Ensure account is active

### Database Issues
1. Ensure MongoDB indexes are created
2. Check connection to MongoDB
3. Verify schema migrations

## Benefits

1. **Solves Ory Token Issue**: API tokens work with HTTP requests
2. **Better Security**: Tokens can be revoked and have scopes
3. **Backward Compatible**: Existing Ory auth still works
4. **Standard Pattern**: Follows industry best practices
5. **Monitoring**: Can track API usage per token

This MVP implementation provides a working solution for the BTCPayServer plugin while maintaining the Flash backend's architectural integrity.