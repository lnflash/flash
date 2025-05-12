# Service Token Recommendations (FIP-07)

This document outlines recommendations for enhancing the long-lived service token implementation in Flash, as specified in FIP-07. While the current implementation meets the core requirements, these recommendations provide a roadmap for future improvements to increase security, monitoring capabilities, and user experience.

## Current Implementation

The existing implementation of FIP-07 (Long-Lived Service Tokens) includes:

1. **Schema Updates**:
   - Added `isServiceAccount` flag to the Account schema
   - Created types for service tokens

2. **Authentication Flow**:
   - Modified session middleware to handle service tokens
   - Added special handling for service token requests (no IP tracking, no session extension)

3. **GraphQL Mutations**:
   - Added `accountSetService` mutation to designate an account as a service account
   - Added `issueServiceToken` mutation to issue long-lived tokens

4. **Domain Layer**:
   - Added service token validation functions
   - Added service token error types
   - Added constants for default/max token duration

## Recommended Enhancements

### 1. Token Revocation

**Priority: High**

Currently, there's no way to revoke individual service tokens without changing the JWT secret. To enhance security, we should implement token revocation:

- Add a `ServiceToken` collection to store token metadata:
  ```typescript
  interface ServiceTokenRecord {
    id: string;           // Token ID (jti claim)
    accountId: string;    // Associated account
    issuedAt: Date;       // When the token was issued
    expiresAt: Date;      // When the token expires
    issuedBy: string;     // Admin who issued the token
    description: string;  // Purpose of the token
    isRevoked: boolean;   // Revocation status
    revokedAt?: Date;     // When it was revoked
    revokedBy?: string;   // Who revoked it
    lastUsed?: Date;      // Last usage timestamp
  }
  ```

- Add a `revokeServiceToken` mutation:
  ```graphql
  revokeServiceToken(input: RevokeServiceTokenInput!): RevokeServiceTokenPayload!
  
  input RevokeServiceTokenInput {
    tokenId: ID!
    reason: String
  }
  
  type RevokeServiceTokenPayload {
    success: Boolean!
    errors: [Error!]!
  }
  ```

- Modify the authentication middleware to check token validity against the database.

### 2. Audit Logging

**Priority: High**

Add comprehensive audit logging for service token operations to enhance security monitoring and compliance:

- Log token lifecycle events:
  - Creation (admin, account, timestamp, expiration)
  - Usage (resource accessed, timestamp, IP)
  - Revocation (admin, reason, timestamp)

- Create an admin query to view token audit logs:
  ```graphql
  serviceTokenAuditLogs(
    tokenId: ID,
    accountId: ID,
    from: Timestamp,
    to: Timestamp,
    first: Int,
    after: String
  ): ServiceTokenAuditLogConnection!
  ```

- Implement database storage for audit logs, with appropriate retention policies.

### 3. Scope Limiting

**Priority: Medium**

Currently, service tokens have full access. Implementing scoped tokens would follow the principle of least privilege:

- Define a set of scopes for the API:
  ```typescript
  enum TokenScope {
    READ_TRANSACTIONS = "tx:read",
    WRITE_TRANSACTIONS = "tx:write",
    READ_ACCOUNT = "account:read",
    // ...other scopes
  }
  ```

- Update the `ServiceToken` schema with scopes:
  ```typescript
  interface ServiceTokenRecord {
    // ...existing fields
    scopes: TokenScope[];
  }
  ```

- Update the `issueServiceToken` mutation to accept scopes:
  ```graphql
  issueServiceToken(
    input: IssueServiceTokenInput!
  ): ServiceTokenPayload!
  
  input IssueServiceTokenInput {
    accountId: ID!
    description: String!
    expiresIn: Int = 30
    scopes: [String!]
  }
  ```

- Add scope checking to the GraphQL resolvers.

### 4. IP Allowlisting

**Priority: Medium**

For enhanced security, implement IP allowlisting for service tokens:

- Update the `ServiceToken` schema:
  ```typescript
  interface ServiceTokenRecord {
    // ...existing fields
    allowedIps: string[]; // CIDR notation or plain IP addresses
  }
  ```

- Add IP validation to the authentication middleware:
  ```typescript
  const validateIpForToken = (
    token: ServiceToken,
    requestIp: string
  ): boolean => {
    if (!token.allowedIps || token.allowedIps.length === 0) {
      return true; // No restrictions
    }
    
    return token.allowedIps.some(ip => 
      isIpInRange(requestIp, ip)
    );
  };
  ```

- Add methods to update the IP allowlist for existing tokens.

### 5. Token Rotation

**Priority: Low**

Add support for token rotation without downtime:

- Support multiple active tokens per service account
- Add a `notifyBeforeExpiration` flag to trigger notifications
- Add a more descriptive name field for better tracking

```typescript
interface ServiceTokenRecord {
  // ...existing fields
  name: string;
  notifyBeforeExpiration: boolean;
  notificationDays: number[]; // e.g., [30, 7, 1]
}
```

- Implement a background job to check for expiring tokens and send notifications.

### 6. Admin UI

**Priority: Low**

Create an admin UI for service token management:

- Dashboard showing:
  - Active service tokens
  - Recently expired tokens
  - Token usage statistics
  - Token issuance trends

- Token management features:
  - Issue new tokens with all parameters
  - Revoke tokens
  - Update token metadata
  - View token audit logs

### 7. Testing

**Priority: High**

Add comprehensive tests to ensure the service token system works correctly:

- **Unit Tests**:
  - Token validation
  - Token expiration handling
  - Scope checking logic

- **Integration Tests**:
  - Authentication flow
  - Token revocation
  - Audit logging

- **E2E Tests**:
  - Token issuance
  - Token usage with different scopes
  - Token revocation impacts

### 8. Documentation

**Priority: Medium**

Create detailed documentation for users:

- Service Token Usage Guide:
  - How to request a service token
  - How to use a service token in API requests
  - Error handling

- Best Practices:
  - Token security
  - Scope limiting
  - Token rotation
  - Error handling

- Admin Guide:
  - Issuing tokens
  - Monitoring token usage
  - Revoking tokens
  - Understanding audit logs

## Implementation Approach

For implementing these improvements, we recommend a phased approach:

### Phase 1 (Critical Security Features):
- Token Revocation
- Basic Audit Logging

### Phase 2 (Enhanced Security):
- Scope Limiting
- IP Allowlisting

### Phase 3 (Operational Improvements):
- Token Rotation
- Advanced Audit Analytics
- Admin UI

### Phase 4 (Documentation & Testing):
- Comprehensive Documentation
- Full Test Coverage

Each phase should include appropriate database migrations, schema updates, and backwards compatibility considerations.

## Conclusion

The current implementation of long-lived service tokens provides a solid foundation for authenticating service accounts with Flash. By implementing these recommended enhancements in a phased approach, we can further improve security, monitoring, and user experience without disrupting existing functionality.