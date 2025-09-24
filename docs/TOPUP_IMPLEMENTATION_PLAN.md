# Topup Implementation Plan

## Overview
Based on the cashout implementation analysis, the topup system should mirror the cashout flow but in reverse:
- **Cashout**: User wallet → Flash bank owner wallet → External bank transfer
- **Topup**: External payment → Flash bank owner wallet → User wallet

## Key Findings from Cashout Analysis

### 1. Database Architecture
- **No separate collection** for cashout transactions
- Uses **Medici double-entry bookkeeping** library
- Transactions stored in `Medici_Transaction` collection
- Transaction type: `LedgerTransactionType.Ibex_invoice`

### 2. Wallet Flow
- Flash uses a **"Bank Owner" wallet** as the central operational wallet
- Retrieved via `getBankOwnerIbexAccount()` function
- This same wallet should be the SOURCE for topup credits

### 3. Ledger Recording Pattern
```typescript
// Cashout (User → Flash):
Debit: Flash Bank Owner Wallet (receives USD)
Credit: Accounts Payable (owes user)
Credit: Revenue:Service Fees (Flash fee)

// Topup (Flash → User) should be:
Debit: External Payment Provider (money received)
Credit: User Wallet (user receives funds)
Debit: Service Fees (if any fees charged)
```

## Implementation Steps

### Phase 1: Infrastructure Setup ✅ COMPLETED
- [x] Config schema for topup providers
- [x] Webhook handlers for Fygaro/Stripe/PayPal
- [x] Basic webhook server integration

### Phase 2: Ledger Integration (Current)

#### 1. Create Topup Transaction Type
**File**: `/src/domain/ledger/index.types.d.ts`
- Add `TopupFygaro = "topup:fygaro"` to `LedgerTransactionType`
- Add `TopupStripe = "topup:stripe"`
- Add `TopupPaypal = "topup:paypal"`

#### 2. Get Bank Owner Wallet
**File**: `/src/app/wallets/get-bank-owner-wallet.ts` (new)
- Create function to retrieve Flash's bank owner wallet
- Similar to `getBankOwnerIbexAccount()` but for internal use

#### 3. Record Topup Transaction
**File**: `/src/services/ledger/facade/topup.ts` (new)
```typescript
export const recordTopup = async ({
  recipientWalletId,
  amount,
  provider,
  externalTransactionId,
  currency,
}) => {
  // Double-entry bookkeeping:
  // Debit: External:Provider:[provider] (money in)
  // Credit: Wallet:[recipientWalletId] (user receives)
  // Debit: Revenue:TopupFees (if fees applied)
}
```

#### 4. Implement Credit Logic
**File**: `/src/services/topup/webhook-handlers/base.ts`
- Replace TODO with actual implementation
- Call `recordTopup` to record ledger entry
- Use Ibex to credit user's wallet from bank owner wallet

### Phase 3: Transaction Processing

#### 1. Idempotency Check
**File**: `/src/services/mongoose/topup-transactions.ts` (new)
- Create schema to track processed webhooks
- Prevent double-processing of same transaction
```typescript
{
  provider: String,
  externalTransactionId: String,
  status: String,
  processedAt: Date,
  amount: Number,
  currency: String,
  userId: String,
  walletId: String
}
```

#### 2. Actual Credit Implementation
```typescript
// In base.ts creditAccount method:
1. Check if transaction already processed (idempotency)
2. Get bank owner wallet
3. Create Ibex invoice for user's wallet
4. Pay invoice from bank owner wallet
5. Record ledger entries via recordTopup
6. Mark transaction as processed
7. Send notification
```

### Phase 4: User Interface

#### 1. GraphQL Schema
- Add `topupTransactions` query to fetch user's topup history
- Add topup transaction type to transaction union

#### 2. Notifications
- Create email templates for successful topup
- Add push notification for mobile app

### Phase 5: Testing & Monitoring

#### 1. Testing
- Unit tests for ledger recording
- Integration tests for webhook processing
- End-to-end test with test webhooks

#### 2. Monitoring
- Add metrics for webhook processing time
- Alert on failed topup attempts
- Track success/failure rates by provider

## Important Considerations

### Security
1. **Webhook Signature Verification**: Already implemented ✅
2. **Idempotency**: Prevent double credits (TODO)
3. **Amount Validation**: Ensure amounts match expected values
4. **Rate Limiting**: Prevent abuse of webhook endpoints

### Error Handling
1. **Insufficient Funds**: Bank owner wallet must have funds
2. **Network Failures**: Retry mechanism for failed credits
3. **Invalid User**: Handle deleted/suspended accounts
4. **Currency Mismatch**: Handle USD/BTC wallet selection

### Audit Trail
1. All transactions recorded in ledger
2. Webhook payloads stored for reconciliation
3. Clear mapping between external and internal transaction IDs

## Next Steps
1. Start with Phase 2, Step 1: Add transaction types
2. Implement bank owner wallet retrieval
3. Create ledger recording function
4. Wire up actual credit logic
5. Add idempotency checks
6. Test with Fygaro sandbox