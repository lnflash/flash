#!/bin/bash

echo "Diagnosing Topup Webhook Setup"
echo "==============================="
echo ""

# Check if webhook server is running
echo "1. Webhook Server Status:"
if lsof -i :4008 | grep -q LISTEN; then
    echo "   ✅ Webhook server is listening on port 4008"
else
    echo "   ❌ Webhook server is NOT listening on port 4008"
    echo "   Run: yarn webhook-dev"
fi
echo ""

# Check MongoDB connection
echo "2. MongoDB Connection:"
if nc -z localhost 27017 2>/dev/null; then
    echo "   ✅ MongoDB is running on port 27017"
else
    echo "   ❌ MongoDB is NOT running"
    echo "   Run: docker-compose up -d mongodb"
fi
echo ""

# Check Redis connection
echo "3. Redis Connection:"
if nc -z localhost 6379 2>/dev/null || nc -z localhost 6378 2>/dev/null; then
    echo "   ✅ Redis is running"
else
    echo "   ❌ Redis is NOT running"
    echo "   Run: docker-compose up -d redis"
fi
echo ""

# Check configuration
echo "4. Configuration Check:"
if [ -f "./dev/defaults.yaml" ]; then
    echo "   ✅ defaults.yaml exists"

    # Check if topup is enabled
    if grep -q "fygaro:" ./dev/defaults.yaml && grep -q "enabled: true" ./dev/defaults.yaml; then
        echo "   ✅ Fygaro topup is enabled"
    else
        echo "   ⚠️  Fygaro topup might not be enabled"
    fi
else
    echo "   ❌ defaults.yaml not found"
fi
echo ""

# Check if Ibex is configured
echo "5. Ibex Configuration:"
if [ ! -z "$IBEX_URL" ] || grep -q "ibex:" ./dev/defaults.yaml; then
    echo "   ✅ Ibex configuration found"
else
    echo "   ⚠️  Ibex might not be configured"
    echo "   Check your .env or configuration files"
fi
echo ""

echo "6. Testing with a non-existent user (should fail gracefully):"
curl -X POST http://localhost:4008/webhooks/topup/fygaro \
  -H "Content-Type: application/json" \
  -d '{
    "event": "payment.succeeded",
    "payment": {
      "id": "test_nonexistent_user",
      "amount": 0.01,
      "currency": "USD",
      "status": "succeeded",
      "metadata": {
        "client_reference": "nonexistentuser123456"
      }
    }
  }' \
  -s -w "Response: %{http_code}\n"

echo ""
echo "Next Steps:"
echo "==========="
echo "1. Check the webhook server logs for specific error messages"
echo "2. Make sure you have a user in the database"
echo "3. Try with a real username instead of 'testuser'"
echo ""
echo "To create a test user (if using GraphQL):"
echo "  - Use the Flash mobile app to create an account"
echo "  - Or use the GraphQL API to create a user"
echo ""
echo "To see available users (if you have database access):"
echo "  - mongo mongodb://localhost:27017/galoy"
echo "  - db.users.find({}, {username: 1})"