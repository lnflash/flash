# Top-up Webhooks Implementation

## Overview

This implementation provides a generic webhook system for handling payment top-ups from multiple providers (Fygaro, Stripe, PayPal, etc.).

## Architecture

```
/src/services/topup/
├── webhook-handlers/
│   ├── base.ts        # Base abstract class for all webhook handlers
│   ├── fygaro.ts      # Fygaro-specific handler
│   ├── stripe.ts      # Stripe-specific handler
│   ├── paypal.ts      # PayPal-specific handler
│   └── index.ts       # Handler registry and exports
└── webhook-server.ts  # Express router setup
```

## Configuration

Add the following to your YAML configuration file:

```yaml
topup:
  providers:
    fygaro:
      enabled: true
      webhook:
        secret: "your-fygaro-webhook-secret"
        path: "/webhooks/topup/fygaro"
      paymentButtonId: "bd4a34c1-3d24-4315-a2b8-627518f70916"

    stripe:
      enabled: false
      webhook:
        secret: "whsec_your_stripe_webhook_secret"
        path: "/webhooks/topup/stripe"

    paypal:
      enabled: false
      webhook:
        secret: "your-paypal-webhook-id"
        path: "/webhooks/topup/paypal"
```

## How It Works

1. **Webhook Registration**: When the server starts, it automatically registers webhook endpoints for all enabled providers.

2. **Request Flow**:
   - Payment provider sends webhook to configured endpoint
   - Handler verifies signature using provider-specific method
   - Payload is parsed and normalized to common format
   - User and wallet are identified from metadata
   - Amount is converted to appropriate currency
   - Account is credited (TODO: implement actual credit logic)
   - Notification is sent to user

3. **Common Payload Format**:
```typescript
interface TopupWebhookPayload {
  provider: string
  transactionId: string
  amount: number
  currency: string
  username: string
  walletType?: "USD" | "BTC"
  email?: string
  status: "succeeded" | "failed" | "pending"
  metadata?: Record<string, any>
}
```

## Provider Setup

### Fygaro

1. In Fygaro dashboard, set webhook URL to: `https://your-api.com/webhooks/topup/fygaro`
2. Copy the webhook secret and add to configuration
3. Ensure payments include `client_reference` metadata with username

### Stripe

1. In Stripe dashboard, create a new webhook endpoint
2. Set URL to: `https://your-api.com/webhooks/topup/stripe`
3. Select events: `payment_intent.succeeded`, `charge.succeeded`
4. Copy webhook signing secret to configuration
5. Include `username` in payment metadata

### PayPal

1. In PayPal developer dashboard, create webhook
2. Set URL to: `https://your-api.com/webhooks/topup/paypal`
3. Subscribe to `PAYMENT.CAPTURE.COMPLETED` events
4. Copy webhook ID to configuration
5. Use `custom_id` field for username

## Mobile App Integration

The mobile app should pass the username in the payment metadata:

```typescript
// For Fygaro
const paymentUrl = `https://fygaro.com/pay?amount=${amount}&client_reference=${username}`

// For Stripe (in payment intent creation)
metadata: { username: currentUser.username, wallet_type: "USD" }

// For PayPal
custom_id: `${walletType}:${username}`
```

## Testing

Health check endpoint: `GET /webhooks/topup/health`

Returns:
```json
{
  "status": "healthy",
  "enabledProviders": ["fygaro", "stripe"]
}
```

## Adding New Providers

1. Create new handler in `/src/services/topup/webhook-handlers/[provider].ts`:

```typescript
import { BaseTopupWebhookHandler } from "./base"

export class MyProviderWebhookHandler extends BaseTopupWebhookHandler {
  provider = "myprovider"

  verifySignature(req: Request): boolean {
    // Implement signature verification
  }

  parsePayload(req: Request): TopupWebhookPayload | Error {
    // Parse provider-specific payload to common format
  }
}
```

2. Register in `/src/services/topup/webhook-handlers/index.ts`

3. Add configuration schema in `/src/config/schema.ts`

## TODO

- [ ] Implement actual account crediting logic with Ibex
- [ ] Add webhook retry mechanism
- [ ] Add webhook event logging/storage
- [ ] Implement idempotency checks
- [ ] Add rate limiting
- [ ] Add monitoring/alerting for failed webhooks
- [ ] Implement webhook replay functionality
- [ ] Add support for refunds/reversals