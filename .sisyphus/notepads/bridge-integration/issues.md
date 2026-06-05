# Bridge Integration - Issues & Gotchas

(To be populated during implementation)


## Task 8: Bridge Webhook Server - Blocked (Needs Breakdown)

**Issue**: Task 8 is too complex for single delegation (7 files to create)

**Breakdown needed:**
1. Create signature verification middleware
2. Create KYC route handler
3. Create deposit route handler  
4. Create transfer route handler
5. Create main server file
6. Create entrypoint + package.json script

**Pattern to follow**: `src/services/ibex/webhook-server/`

**Key differences from IBEX**:
- Asymmetric signature verification (RSA-SHA256) not HMAC
- Must capture raw body for signature verification
- Routes at root: `/kyc`, `/deposit`, `/transfer`
- Timestamp skew check (5 minutes)

**Status**: Directory structure created, files need implementation

