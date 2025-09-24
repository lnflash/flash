#!/bin/bash

# Test Fygaro webhook endpoint

echo "Testing Fygaro topup webhook on localhost:4008..."
echo ""

# Test 1: Basic connectivity
echo "1. Testing webhook endpoint availability:"
curl -s -o /dev/null -w "Response code: %{http_code}\n" \
  -X GET http://localhost:4008/webhooks/topup/health || echo "Health endpoint not available"

echo ""
echo "2. Testing webhook with minimal payload:"

# Minimal test payload
curl -X POST http://localhost:4008/webhooks/topup/fygaro \
  -H "Content-Type: application/json" \
  -d '{
    "event": "payment.succeeded",
    "payment": {
      "id": "test_minimal_001",
      "amount": 1.00,
      "currency": "USD",
      "status": "succeeded",
      "metadata": {
        "client_reference": "testuser"
      }
    }
  }' \
  -s -w "\nHTTP Status: %{http_code}\n"

echo ""
echo "3. Testing webhook with complete payload:"

# Complete test payload
curl -X POST http://localhost:4008/webhooks/topup/fygaro \
  -H "Content-Type: application/json" \
  -d '{
    "event": "payment.succeeded",
    "payment": {
      "id": "test_complete_001",
      "amount": 10.00,
      "currency": "USD",
      "status": "succeeded",
      "customer": {
        "email": "test@example.com",
        "name": "Test User"
      },
      "metadata": {
        "client_reference": "testuser",
        "wallet_type": "USD"
      },
      "created_at": "2024-01-15T10:30:00Z",
      "payment_method": "card"
    }
  }' \
  -s -w "\nHTTP Status: %{http_code}\n"

echo ""
echo "Check the Flash application logs (where you're running the webhook server) for details."
echo ""
echo "Common issues:"
echo "1. User 'testuser' might not exist - replace with a real username"
echo "2. Bank owner wallet might not be configured"
echo "3. Ibex credentials might not be set"
echo ""
echo "To see logs, check the terminal where you ran:"
echo "  yarn webhook-dev"
echo "or"
echo "  yarn tsnd src/servers/ibex-webhook-server.ts"