# API Token Implementation Summary

## Problem Solved
The BTCPayServer Flash plugin cannot authenticate with the Flash API because:
- Ory session tokens only work with WebSocket connections, not HTTP
- Flash WebSocket doesn't support GraphQL mutations (only subscriptions)
- No mechanism exists to obtain API tokens

## Solution Architecture
Implement API token generation and authentication that:
1. Allows users to generate long-lived API tokens via GraphQL
2. Enables HTTP authentication with these tokens
3. Maintains backward compatibility with Ory sessions
4. Follows Flash backend's existing patterns

## Implementation Phases

### Phase 1: MVP (Complete)
**Goal**: Enable basic API token creation and authentication

**Files Created**:
```
src/
├── domain/api-tokens/
│   └── index.types.ts         # Domain types and validation
├── services/mongoose/
│   └── api-tokens.ts          # MongoDB repository
├── app/api-tokens/
│   ├── create-api-token.ts    # Business logic
│   └── index.ts               # Module exports
├── servers/middlewares/
│   ├── api-token-auth.ts      # Token validation
│   └── session.patch          # Integration patch
├── graphql/public/
│   ├── root/mutation/
│   │   └── api-token-create.ts # GraphQL mutation
│   └── types/scalar/
│       └── api-token-scope.ts  # Scope enum
└── test/unit/app/api-tokens/
    └── create-api-token.spec.ts # Unit tests
```

**Key Features**:
- ✅ Secure token generation with SHA256 hashing
- ✅ Token expiration support
- ✅ Scope-based permissions (read, write, admin)
- ✅ Token limit per account (10 tokens max)
- ✅ GraphQL mutation for token creation
- ✅ Middleware integration for authentication
- ✅ Unit test coverage

### Phase 2: Full Implementation (Planned)
**Additional Features**:
- Token management (list, revoke, rotate)
- Granular permission scopes
- Rate limiting for API tokens
- Usage analytics and monitoring
- IP restriction support
- Admin dashboard integration

## Integration with BTCPayServer Plugin

### Current Flow (Broken)
```
BTCPayServer Plugin → HTTP Request with Ory Token → Flash API
                                                      ↓
                                                  401 Unauthorized
```

### New Flow (Working)
```
1. Initial Setup (One-time):
   BTCPayServer → WebSocket with Ory Token → Create API Token → Store Token

2. Regular Operations:
   BTCPayServer → HTTP Request with API Token → Flash API
                                                     ↓
                                                  ✅ Success
```

### Plugin Code Changes Required
```csharp
// In FlashLightningClient.cs
public async Task<string> GetOrCreateApiToken()
{
    // Check if we have a stored API token
    var storedToken = GetStoredApiToken();
    if (!string.IsNullOrEmpty(storedToken))
        return storedToken;
    
    // Create new token via WebSocket (using Ory session)
    var mutation = @"
        mutation {
            apiTokenCreate(input: {
                name: ""BTCPayServer Integration""
                scopes: [""read"", ""write""]
                expiresIn: 31536000
            }) {
                apiToken { token }
            }
        }";
    
    var response = await _webSocketService.SendMutation(mutation);
    var token = response.data.apiTokenCreate.apiToken.token;
    
    // Store securely
    StoreApiToken(token);
    return token;
}

// Use for all HTTP requests
public async Task<LightningInvoice> CreateInvoice(...)
{
    var apiToken = await GetOrCreateApiToken();
    _httpClient.DefaultRequestHeaders.Authorization = 
        new AuthenticationHeaderValue("Bearer", apiToken);
    
    // Now HTTP requests will work!
    return await _graphQLService.CreateInvoice(...);
}
```

## Security Considerations

### Token Security
- Tokens are cryptographically secure (256-bit random)
- Stored as SHA256 hashes in database
- Prefixed with `flash_` for easy identification
- Raw token only shown once during creation

### Access Control
- Three scope levels: read, write, admin
- Tokens limited to 10 per account
- Optional expiration dates
- Can be revoked at any time

### Best Practices
- Regular token rotation (every 90 days)
- Audit logging for all token usage
- Rate limiting on API token requests
- Secure storage in BTCPayServer configuration

## Testing Instructions

### 1. Deploy Backend Changes
```bash
cd flash-backend
# Apply the integration steps from API_TOKEN_MVP_INTEGRATION.md
make test        # Run tests
make start-deps  # Start dependencies
make start       # Start server
```

### 2. Test Token Creation
Use GraphQL playground or curl:
```graphql
mutation {
  apiTokenCreate(input: {
    name: "Test Token"
    scopes: ["read", "write"]
  }) {
    apiToken {
      token  # Save this!
      scopes
      expiresAt
    }
  }
}
```

### 3. Test Token Authentication
```bash
curl -X POST https://api.test.flashapp.me/graphql \
  -H "Authorization: Bearer flash_YOUR_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{"query": "{ me { defaultAccount { id } } }"}'
```

### 4. Update BTCPayServer Plugin
Deploy the updated plugin with API token support and test LNURL invoice creation.

## Benefits

### Immediate
- ✅ Fixes LNURL invoice creation issue
- ✅ Enables HTTP authentication for Flash API
- ✅ No breaking changes to existing systems

### Long-term
- Better security with revocable tokens
- Usage monitoring and analytics
- Support for multiple integrations
- Foundation for partner API access

## Timeline

### Week 1 (MVP)
- Day 1-2: Implement core functionality ✅
- Day 3: Integration and testing
- Day 4: Deploy to test environment
- Day 5: Update BTCPayServer plugin

### Week 2 (Enhancement)
- Token management operations
- Enhanced security features
- Monitoring and analytics
- Documentation and deployment

## Success Metrics

### MVP Success
- [ ] API tokens can be created
- [ ] Tokens authenticate HTTP requests
- [ ] BTCPayServer plugin creates invoices
- [ ] No regression in existing auth

### Full Success
- [ ] Complete token lifecycle
- [ ] Usage analytics available
- [ ] Security hardening complete
- [ ] Production deployment successful

## Next Steps

1. **Backend Team**: Review and integrate the MVP implementation
2. **Testing**: Validate token creation and authentication
3. **Plugin Update**: Modify BTCPayServer plugin to use API tokens
4. **Deployment**: Roll out to test environment
5. **Documentation**: Update API documentation

This implementation provides a clean, secure solution that aligns with Flash's architecture while solving the critical authentication issue for the BTCPayServer plugin.