# Flash API Key Management System

The API key management system allows third-party developers to securely access Flash's GraphQL API with fine-grained permissions and advanced security features.

## Documentation Overview

These files provide a comprehensive overview of the API key system:

1. [**API_KEY_IMPLEMENTATION.md**](./API_KEY_IMPLEMENTATION.md) - Initial implementation plan with step-by-step guide
2. [**API_KEY_IMPLEMENTATION_DETAILS.md**](./API_KEY_IMPLEMENTATION_DETAILS.md) - Detailed explanation of the actual implementation
3. [**ABSOLUTE_ZERO_METHOD.md**](./ABSOLUTE_ZERO_METHOD.md) - Documentation of the AZ-RSP methodology used for development
4. [**AZ_RSP_SUMMARY.md**](./AZ_RSP_SUMMARY.md) - Summary of accomplishments and next steps
5. [**API_KEY_ROADMAP.md**](./API_KEY_ROADMAP.md) - Implementation roadmap and timeline
6. [**CASHOUT_API_INTEGRATION.md**](./CASHOUT_API_INTEGRATION.md) - Guide for integrating with cashout notifications

## Key Components

The API key system consists of several key components:

1. **Domain Layer** - Core concepts, validation, and error types
   - `src/domain/api-keys/*`

2. **Mongoose Schema** - Database schema for API keys
   - `src/services/mongoose/api-keys.ts`

3. **API Key Service** - Business logic for key lifecycle management
   - `src/services/api-keys/index.ts`

4. **Authentication Middleware** - Express middleware for API key validation
   - `src/servers/middlewares/api-key-auth.ts`

5. **Rate Limiting** - Adaptive rate limiting based on usage patterns
   - `src/services/rate-limit/adaptive-rate-limiter.ts`

6. **GraphQL Integration** - Resolvers and types for API key management
   - `src/graphql/public/mutations/api-key.ts`
   - `src/graphql/public/queries/api-key.ts`
   - `src/graphql/public/types/api-key.ts`

7. **Authorization Rules** - GraphQL Shield rules for permission enforcement
   - `src/graphql/public/rules/api-key-rules.ts`
   - `src/graphql/public/permissions/api-key-permissions.ts`

## Usage Examples

### Creating an API Key

```graphql
mutation CreateApiKey {
  createApiKey(
    input: {
      name: "My API Key"
      type: TEST
      scopes: ["read:account", "read:wallet", "read:transaction"]
    }
  ) {
    id
    name
    type
    scopes
    apiKey
  }
}
```

### Authenticating Requests

Add the API key to the Authorization header:

```
Authorization: ApiKey flash_test_xxxxxxxxxxxxxxxxxxxxx
```

### Making GraphQL Requests

```graphql
query GetWalletBalance {
  me {
    defaultAccount {
      wallets {
        id
        balance
        currency
      }
    }
  }
}
```

## Security Features

The API key system includes several security features:

- **Secure Key Format**: Keys follow a standardized format with high entropy
- **Hashed Storage**: Keys are never stored in plaintext
- **Timing-Safe Comparison**: Prevents timing attacks
- **Scope-Based Permissions**: Fine-grained access control
- **Adaptive Rate Limiting**: Protection against abuse
- **IP Constraints**: Optional restriction by IP address
- **Zero-Downtime Rotation**: Secure key rotation without service disruption
- **Webhook Signatures**: Secure callback verification
- **Comprehensive Logging**: Detailed audit trail

## Development Using AZ-RSP

The API key management system was developed using the Absolute Zero Reinforced Self-Play (AZ-RSP) methodology, which provides:

1. **Task Generation** - Systematically created enhancement tasks
2. **Verifiable Environment** - Objective validation of implementations
3. **Iterative Enhancement** - Continuous improvement through feedback
4. **Comprehensive Testing** - Thorough verification of all components

For more details on how to use AZ-RSP for further enhancements, see [ABSOLUTE_ZERO_METHOD.md](./ABSOLUTE_ZERO_METHOD.md).

## Next Steps

The roadmap for further development is outlined in [API_KEY_ROADMAP.md](./API_KEY_ROADMAP.md) and includes:

1. Additional security enhancements
2. Developer dashboard implementation
3. Advanced analytics and monitoring
4. Integration with other Flash components
5. OAuth2 support for delegated access