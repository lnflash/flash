# Fygaro Webhook Configuration Guide

## Prerequisites

1. **Fygaro Account**: You need access to the Fygaro dashboard
2. **Payment Button**: Your payment button ID (currently: `bd4a34c1-3d24-4315-a2b8-627518f70916`)

## Step 1: Configure Webhook URL in Fygaro

1. Log in to [Fygaro Dashboard](https://fygaro.com)
2. Navigate to your Payment Button settings
3. Find the "Webhook Links" section
4. Add your webhook URL:
   - **Development**: `http://your-dev-server:4008/webhooks/topup/fygaro`
   - **Production**: `https://api.your-domain.com/webhooks/topup/fygaro`
5. Save the configuration

**Note**: Fygaro payment buttons may not provide webhook secrets. Our implementation accepts webhooks without signature verification when no secret is configured.

## Step 2: Configure Flash Application

The default configuration in `dev/defaults.yaml` is already set up:

```yaml
topup:
  providers:
    fygaro:
      enabled: true
      webhook:
        secret: ""  # Leave empty if Fygaro doesn't provide a secret
        path: "/webhooks/topup/fygaro"
      paymentButtonId: "bd4a34c1-3d24-4315-a2b8-627518f70916"
```

**Security Note**: Since Fygaro doesn't provide webhook secrets for payment buttons, consider these security measures:
- Use HTTPS in production to encrypt webhook data
- Monitor webhook logs for suspicious activity
- Validate the webhook payload structure
- Consider implementing IP whitelisting if Fygaro provides their IP ranges

## Step 4: Test the Webhook

### Using Fygaro Test Mode

1. Make a test payment through Fygaro
2. Check Flash application logs for webhook receipt:
   ```bash
   docker logs flash-api | grep "topup"
   ```
3. Verify the signature verification passes
4. Check that the user's wallet is credited

### Manual Testing with cURL

You can test the webhook endpoint manually (no signature required):

```bash
# Test payload matching Fygaro's structure
PAYLOAD='{
  "event": "payment.succeeded",
  "payment": {
    "id": "test_payment_123",
    "amount": 10.00,
    "currency": "USD",
    "status": "succeeded",
    "customer": {
      "email": "test@example.com"
    },
    "metadata": {
      "client_reference": "testuser",
      "wallet_type": "USD"
    },
    "created_at": "2024-01-15T10:30:00Z"
  }
}'

# Send webhook
curl -X POST http://localhost:4008/webhooks/topup/fygaro \
  -H "Content-Type: application/json" \
  -d "${PAYLOAD}"
```

Expected response: `200 OK`

## Webhook Security

### Current Implementation

Since Fygaro payment buttons don't provide webhook secrets, our implementation:
1. **Accepts all webhooks** when no secret is configured
2. **Logs the source IP** for monitoring
3. **Validates payload structure** to ensure it matches expected format
4. **Uses idempotency checks** to prevent duplicate processing

### Recommended Security Measures

1. **Use HTTPS in Production**: Ensures webhook data is encrypted in transit
2. **Monitor Logs**: Watch for unusual patterns or suspicious IPs
3. **Validate Payload**: Check that required fields are present and valid
4. **IP Whitelisting**: If Fygaro provides their IP ranges, add them to the verification
5. **Rate Limiting**: Implement rate limits on the webhook endpoint
6. **Idempotency**: Each transaction ID is only processed once (already implemented)

## Troubleshooting

### Webhook Not Received

1. **Check Network**:
   - Ensure your server is accessible from the internet
   - Check firewall rules allow incoming HTTPS/HTTP
   - Verify the port (4008) is open

2. **Check Logs**:
   ```bash
   # Check if webhook server is running
   docker logs flash-api | grep "Listening for webhook events"

   # Check for any webhook activity
   docker logs flash-api | grep -i "fygaro"
   ```

### Signature Verification Fails

1. **Common Issues**:
   - Wrong secret in configuration
   - Secret has trailing spaces or newlines
   - Time sync issues (server time off by >5 minutes)

2. **Debug Logging**:
   - The handler logs detailed error messages
   - Check for "Invalid Fygaro-Signature format" or "Webhook timestamp outside of allowed window"

### Transaction Not Credited

1. **Check Idempotency**:
   - Same transaction ID won't be processed twice
   - Check logs for "Topup transaction already processed"

2. **Check Ibex Connection**:
   - Ensure Ibex credentials are correct
   - Bank owner wallet must have funds
   - Check for "Failed to create invoice" or "Failed to pay topup invoice"

## Webhook Payload Example

Here's what a typical Fygaro webhook payload looks like:

```json
{
  "transactionId": "fyg_1234567890abcdef",
  "reference": "username_or_client_reference",
  "amount": 50.00,
  "currency": "USD",
  "status": "completed",
  "paymentMethod": "card",
  "cardDetails": {
    "last4": "4242",
    "brand": "visa"
  },
  "customer": {
    "email": "customer@example.com",
    "name": "John Doe"
  },
  "metadata": {
    "client_reference": "username",
    "wallet_type": "USD"
  },
  "createdAt": "2024-01-15T10:30:00Z"
}
```

## Important Notes

1. **Username Mapping**: The `reference` or `metadata.client_reference` field must contain the Flash username
2. **Wallet Type**: Use `metadata.wallet_type` to specify "USD" or "BTC"
3. **Amount**: Always in the currency specified (e.g., 50.00 USD)
4. **Idempotency**: Each `transactionId` is only processed once

## Production Checklist

- [ ] Webhook secret stored securely (environment variable or secret manager)
- [ ] HTTPS endpoint configured (not HTTP)
- [ ] Monitoring/alerting for webhook failures
- [ ] Error handling for network issues
- [ ] Logging configured appropriately (no sensitive data)
- [ ] Rate limiting to prevent abuse
- [ ] Backup mechanism if webhooks fail