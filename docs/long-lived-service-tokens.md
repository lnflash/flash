# Long-Lived Service Tokens for Flash GraphQL (FIP-07)

This document describes the implementation of long-lived service tokens for Flash's GraphQL API as specified in FIP-07.

## Overview

Long-lived service tokens provide a way for partner services and internal tools to securely authenticate with Flash's API for extended durations (up to 365 days) without requiring frequent token refreshes or the full API key infrastructure.

## Key Features

1. **Service Account Type**: Adds an `isServiceAccount` flag to the Account schema
2. **Long-Lived Tokens**: Enables JWTs that can be valid for up to 365 days
3. **Admin-Only Issuance**: Only administrators can designate accounts as service accounts and issue tokens
4. **Audit Features**: Service tokens contain description and metadata for tracing
5. **Special Handling**: Service tokens don't trigger session extensions or IP logging

## Implementation Details

### New Database Fields

Added a new field to the Account schema:

```typescript
isServiceAccount: {
  type: Boolean,
  default: false,
  index: true,
}
```

### New GraphQL Mutations

Two new admin-only mutations were added:

1. **accountSetService**: Designate an account as a service account
   ```graphql
   mutation {
     accountSetService(input: {
       accountId: "account-id",
       isServiceAccount: true
     }) {
       accountDetails {
         id
         isServiceAccount
       }
       errors {
         message
       }
     }
   }
   ```

2. **issueServiceToken**: Issue a long-lived service token for an account
   ```graphql
   mutation {
     issueServiceToken(input: {
       accountId: "account-id",
       description: "Service token for backend automation",
       expiresIn: 30  # in days
     }) {
       token
       errors {
         message
       }
     }
   }
   ```

### Token Format

Service tokens are standard JWTs with these special properties:

- Standard claims: `sub` (subject), `exp` (expiration time)
- Additional claims:
  - `type: "service"` - Identifies this as a service token
  - `description: "..."` - Audit information about token purpose

### Authentication Flow

1. An admin designates an account as a service account using the `accountSetService` mutation
2. An admin issues a service token for the account using the `issueServiceToken` mutation
3. The service uses this token in API requests with standard Bearer token authentication
4. The session middleware detects the token type and applies special handling:
   - No IP tracking for service tokens
   - No session extension attempts
   - Still validates all other security properties

### Limitations

- Service tokens do not refresh automatically
- Maximum token lifetime is 365 days
- Only admin users can issue service tokens
- Tokens cannot be revoked (except by changing the JWT secret)
- The account must be designated as a service account before tokens can be issued

## Usage Example

1. Make an account a service account:
   ```graphql
   mutation {
     accountSetService(input: {
       accountId: "account-id",
       isServiceAccount: true
     }) {
       accountDetails {
         id
         isServiceAccount
       }
     }
   }
   ```

2. Issue a 90-day service token:
   ```graphql
   mutation {
     issueServiceToken(input: {
       accountId: "account-id",
       description: "Integration with Company X",
       expiresIn: 90
     }) {
       token
     }
   }
   ```

3. Use the token to authenticate API requests:
   ```
   Authorization: Bearer <token>
   ```