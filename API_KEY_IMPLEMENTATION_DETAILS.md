# API Key Implementation Details

This document provides detailed information about the implementation of the API key management system in Flash. It covers the key components, security considerations, and usage patterns.

## Key Components

### 1. Domain Layer

The domain layer defines the core concepts, validation rules, and error types for API keys.

#### Key Files:
- `src/domain/api-keys/index.ts`: Core domain types and utilities
- `src/domain/api-keys/api-key-validator.ts`: Validation functions
- `src/domain/api-keys/errors.ts`: Domain-specific error types
- `src/domain/api-keys/index.types.d.ts`: TypeScript definitions

#### Key Concepts:
- **ApiKeyType**: Differentiates between test and live keys
- **ApiKeyStatus**: Tracks the lifecycle state of keys (active, revoked, expired, rotating)
- **ScopeType and ResourceType**: Define permission granularity
- **Scope**: Combines ScopeType and ResourceType (e.g., "read:account")
- **API key format**: Structured as "flash_{type}_{random_string}"

### 2. Data Layer

The data layer provides persistence for API keys and related information.

#### Key Files:
- `src/services/mongoose/api-keys.ts`: Mongoose schema for API keys
- `src/services/mongoose/schema.types.d.ts`: TypeScript definitions

#### Schema Features:
- Secure storage of hashed keys (never store raw keys)
- Key metadata (name, account, creation date, etc.)
- Scope list for permissions
- Usage history tracking
- Key rotation support

### 3. Service Layer

The service layer implements business logic for API key operations.

#### Key Files:
- `src/services/api-keys/index.ts`: Core API key service
- `src/services/api-keys/index.types.d.ts`: TypeScript definitions

#### Key Operations:
- **create**: Generates new API keys with secure randomness
- **getById/listByAccountId**: Retrieves key information
- **verifyKey**: Securely validates API keys using timing-safe comparison
- **update/revoke**: Manages key lifecycle
- **initiateRotation/completeRotation**: Supports zero-downtime key rotation
- **logUsage**: Tracks API key usage
- **generateWebhookSignature/verifyWebhookSignature**: Secures webhook callbacks

### 4. Authentication Middleware

The middleware layer integrates API key authentication with Express.

#### Key Files:
- `src/servers/middlewares/api-key-auth.ts`: Express middleware
- `src/services/rate-limit/adaptive-rate-limiter.ts`: Rate limiting support

#### Key Features:
- Extracts API keys from Authorization header or query parameter
- Validates keys against the service layer
- Applies rate limiting based on key tier
- Sets rate limit headers for client visibility
- Populates request context with key information
- Logs usage asynchronously

### 5. GraphQL Integration

The GraphQL layer exposes API key management through the API.

#### Key Files:
- `src/graphql/public/context.ts`: Context provider for API keys
- `src/graphql/public/rules/api-key-rules.ts`: GraphQL Shield rules
- `src/graphql/public/permissions/api-key-permissions.ts`: Permission definitions
- `src/graphql/public/types/api-key.ts`: GraphQL type definitions
- `src/graphql/public/mutations/api-key.ts`: Mutation resolvers
- `src/graphql/public/queries/api-key.ts`: Query resolvers

#### Key Features:
- Full CRUD operations for API keys
- Scope-based permissions for GraphQL operations
- Support for key rotation workflow
- Integration with existing authentication

## Security Considerations

### 1. Key Storage

- API keys are never stored in plaintext
- Only a hashed representation is saved in the database
- Private keys for signing are securely stored

### 2. Timing Attacks Prevention

- Timing-safe comparisons are used for key validation
- Keys are structured to prevent pattern recognition

### 3. Rate Limiting

- The adaptive rate limiter adjusts based on usage patterns
- Suspicious activity detection triggers automatic throttling
- Different tiers support various rate limit thresholds

### 4. Scope-Based Authorization

- Fine-grained permissions control access to specific resources
- Each GraphQL operation is protected by appropriate scope requirements
- Combined authorization allows both API key and JWT authentication

### 5. Key Rotation

- Zero-downtime key rotation supports security best practices
- Transition periods allow gradual migration to new keys
- Clear rotation status tracking prevents inconsistencies

## Usage Examples

### 1. Creating an API Key

```typescript
// Using the service directly
const apiKey = await ApiKeyService.create({
  name: "My API Key",
  accountId: "user123",
  type: ApiKeyType.Test,
  scopes: ["read:account", "read:wallet"],
  tier: "DEFAULT",
});

// The apiKey.apiKey property contains the raw key value
// This is the only time the raw key is available
console.log(apiKey.apiKey); // flash_test_xxxxxxxxxxx
```

### 2. Authenticating with an API Key

```typescript
// Set the Authorization header
const headers = {
  "Authorization": "ApiKey flash_test_xxxxxxxxxxx"
};

// Or use a query parameter (less secure)
const url = "https://api.flash.com/graphql?apiKey=flash_test_xxxxxxxxxxx";
```

### 3. Verifying a Webhook Signature

```typescript
// When receiving a webhook
const isValid = await ApiKeyService.verifyWebhookSignature(
  apiKeyId,
  payload,
  request.headers["x-flash-signature"],
  parseInt(request.headers["x-flash-timestamp"], 10)
);

if (!isValid) {
  throw new Error("Invalid webhook signature");
}
```

## Testing

The API key system is thoroughly tested:

1. **Unit tests** for domain validators and service methods
2. **Middleware tests** for authentication flow
3. **GraphQL resolver tests** for API operations
4. **Integration tests** for end-to-end validation

## Monitoring and Security Practices

To ensure secure operation:

1. **Monitor usage patterns** for unusual activity
2. **Regularly rotate keys** following security best practices
3. **Audit key creation and usage** through logging
4. **Enforce key expiration** for temporary access
5. **Implement scope restrictions** based on the principle of least privilege

## Future Enhancements

Planned enhancements to the API key system:

1. **Analytics dashboard** for API key usage visualization
2. **IP restrictions** for additional security
3. **Automated key rotation reminders** based on key age
4. **Enhanced anomaly detection** using machine learning
5. **Custom rate limiting profiles** for specialized use cases