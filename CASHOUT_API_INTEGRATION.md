# Cashout Notification API Integration

This document outlines how the API key management system can be integrated with the cashout notification feature being developed on the `feat/cashout-notify` branch.

## Cashout Notification API Requirements

When implementing the API key system, we should ensure it properly supports the cashout notification use case:

### API Endpoints to Secure

1. **Cashout Status Queries**
   - Query to check status of a specific cashout transaction
   - Query to list recent cashouts with filtering options
   - Subscription for real-time cashout status updates

2. **Notification Configuration**
   - Mutation to register webhook endpoints for cashout notifications
   - Mutation to update notification preferences
   - Query to view current notification settings

3. **Callback Authentication**
   - Mechanism to verify webhook callbacks are authentic
   - Support for webhook signature verification

## API Key Integration Checklist

### 1. Scopes for Cashout API

- [ ] Define granular scopes for cashout-related operations:
  - `cashout:read` - Read-only access to cashout information
  - `cashout:status` - Access to status updates only
  - `cashout:notifications` - Configure notification preferences
  - `cashout:webhook` - Register and manage webhooks

### 2. GraphQL Shield Rules

- [ ] Implement GraphQL Shield rules for cashout-related resolvers:

```typescript
const cashoutPermissions = {
  Query: {
    cashoutById: rule({ cache: 'contextual' })(
      async (_, __, ctx) => hasScope(ctx, 'cashout:read')
    ),
    cashouts: rule({ cache: 'contextual' })(
      async (_, __, ctx) => hasScope(ctx, 'cashout:read')
    ),
  },
  Mutation: {
    registerCashoutWebhook: rule({ cache: 'contextual' })(
      async (_, __, ctx) => hasScope(ctx, 'cashout:webhook')
    ),
    updateNotificationPreferences: rule({ cache: 'contextual' })(
      async (_, __, ctx) => hasScope(ctx, 'cashout:notifications')
    ),
  },
  Subscription: {
    cashoutStatusChanged: rule({ cache: 'contextual' })(
      async (_, __, ctx) => hasScope(ctx, 'cashout:status')
    ),
  },
};
```

### 3. Rate Limiting Configuration

- [ ] Define appropriate rate limits for cashout API operations:

```typescript
const cashoutRateLimits = {
  'cashout:read': {
    DEFAULT: {
      points: 100,
      duration: 60, // 100 requests per minute
    },
    PREMIUM: {
      points: 1000,
      duration: 60, // 1000 requests per minute
    },
  },
  'cashout:webhook': {
    DEFAULT: {
      points: 10,
      duration: 60, // 10 requests per minute
    },
    PREMIUM: {
      points: 100,
      duration: 60, // 100 requests per minute
    },
  },
};
```

### 4. Webhook Authentication

- [ ] Implement webhook signature generation and verification:

```typescript
// When sending a webhook
const generateWebhookSignature = (payload: any, apiKeySecret: string): string => {
  const hmac = crypto.createHmac('sha256', apiKeySecret);
  hmac.update(JSON.stringify(payload));
  return hmac.digest('hex');
};

// Headers to include
const webhookHeaders = {
  'X-Flash-Signature': signature,
  'X-Flash-Timestamp': timestamp,
};
```

### 5. Notification Delivery Service

- [ ] Extend notification service to support API client delivery:

```typescript
class NotificationService {
  // Existing methods...
  
  async notifyCashoutStatusChange(cashoutId: string, newStatus: CashoutStatus): Promise<void> {
    // Get all API clients subscribed to this cashout
    const subscribers = await this.getSubscribers(cashoutId);
    
    // Send notifications to each subscriber
    for (const subscriber of subscribers) {
      await this.sendWebhookNotification(
        subscriber.webhookUrl,
        subscriber.apiKeyId,
        {
          type: 'cashout.status_update',
          data: {
            cashoutId,
            status: newStatus,
            timestamp: new Date().toISOString(),
          }
        }
      );
    }
  }
}
```

### 6. Documentation

- [ ] Create API documentation for cashout notification API:
  - Authentication requirements
  - Available endpoints
  - Request/response formats
  - Webhook integration guide
  - Example code

### 7. Testing

- [ ] Develop comprehensive tests for the API integration:
  - Authentication with API keys
  - Authorization with scopes
  - Rate limiting under load
  - Webhook delivery and verification
  - Error handling and recovery

## Implementation Strategy

### Phase 1: API Key Support in Cashout Notification Schema

1. Add API key-specific fields to webhook registration
2. Update GraphQL schema to include API key requirements
3. Add scope definitions for cashout operations

### Phase 2: Authentication and Authorization

1. Implement API key extraction in GraphQL context
2. Add GraphQL Shield rules for authorization
3. Update resolvers to validate permissions

### Phase 3: Webhook Enhancement

1. Implement webhook signature generation
2. Create webhook verification endpoint
3. Add retry logic for webhook delivery failures

### Phase 4: Testing and Documentation

1. Create integration tests for full API key flow
2. Write developer documentation for API usage
3. Create examples for common integration scenarios

## Conclusion

By following this integration checklist, we can ensure that the cashout notification feature properly leverages the API key management system for secure third-party access. This will allow developers to build applications that can receive real-time updates on cashout status while maintaining the security and performance of the Flash platform.