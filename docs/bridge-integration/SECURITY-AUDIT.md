# Bridge Integration Security Audit — ENG-279

**Auditor:** Vandana (forge0x)  
**Branch:** `feature/bridge-integration`  
**Date:** 2026-04-01  

---

## Summary

The Bridge integration handles real money movement (USDT → ACH). Overall the auth and webhook verification architecture is sound. Three findings require fixes before merge — one critical, one high, one medium.

---

## 🔴 CRITICAL — Amount Not Validated Before Sending to Bridge API

**File:** `src/services/bridge/index.ts` → `initiateWithdrawal`  
**File:** `src/graphql/public/root/mutation/bridge-initiate-withdrawal.ts`

The `amount` parameter is a raw `GT.String` / `string` with no validation. It's passed directly to `BridgeClient.createTransfer({ amount, ... })` without:
- Checking it's a valid positive number
- Checking it's above minimum (Bridge rejects < $1 transfers)
- Preventing `"0"`, `"-100"`, `"NaN"`, exponential notation (`"1e10"`), or injection strings

**Impact:** Malformed amounts will either cause unhandled Bridge API errors (already caught), but more importantly — there is no minimum amount check, meaning a user could attempt to drain bridge accounts with micro-transfers, potentially hitting Bridge API rate limits or triggering fees.

**Fix:**
```typescript
// In initiateWithdrawal, before calling BridgeClient:
const amountNum = parseFloat(amount)
if (isNaN(amountNum) || amountNum <= 0 || amountNum < 1.0) {
  return new ValidationError("Amount must be a positive number >= $1.00")
}
// Use normalized string to avoid scientific notation
const normalizedAmount = amountNum.toFixed(2)
```

---

## 🟡 HIGH — Fake Email in Bridge Customer Creation

**File:** `src/services/bridge/index.ts`

```typescript
email: `${account.id}@flash.app`, // Placeholder - should use real email
```

Using a fake placeholder email when creating Bridge customers. This will:
1. Cause Bridge KYC emails to be undeliverable (users won't receive KYC completion links)
2. Violate Bridge's ToS (KYC requires real contact information)
3. Block account recovery if Bridge needs to contact the user

This is also tracked as **ENG-278**. Must be fixed before production.

**Fix:** Use the authenticated user's real email from Kratos identity. The identity is available in the resolver context and can be passed down, or fetched from `IdentityRepository().getIdentity(account.kratosUserId)`.

---

## 🟡 HIGH — External Account Ownership Not Verified in Withdrawal

**File:** `src/services/bridge/index.ts` → `initiateWithdrawal`

```typescript
const targetAccount = externalAccounts.find(
  (acc) => acc.bridgeExternalAccountId === externalAccountId,
)
```

The code correctly fetches external accounts for the authenticated `accountId`, then looks up the target. **But** — what happens when `targetAccount` is not found? Let me check the actual code path:

```typescript
// From the service code:
const targetAccount = externalAccounts.find(...)
// If undefined: falls through to BridgeClient.createTransfer with the raw externalAccountId
// No early return if targetAccount is undefined!
```

This means if the external account ID is not in the user's list, the transfer is attempted anyway with the raw ID. Bridge may reject it (the customer/external account mismatch), but this should be explicitly rejected server-side before making any API call.

**Fix:**
```typescript
if (!targetAccount) {
  return new BridgeExternalAccountNotFoundError(
    "External account not found or not owned by this account"
  )
}
```

---

## 🟢 PASSES — Webhook Signature Verification

`src/services/bridge/webhook-server/middleware/verify-signature.ts`

RSA-SHA256 asymmetric verification is correctly implemented:
- ✅ Timestamp skew check (default 5 min window)
- ✅ Raw body used for verification (not parsed JSON)
- ✅ Separate public keys per webhook type (kyc/deposit/transfer)
- ✅ Proper error handling without leaking details

---

## 🟢 PASSES — GraphQL Mutation Auth

All Bridge mutations:
- ✅ Use `GraphQLPublicContextAuth` (requires authenticated session)
- ✅ Enforce `domainAccount.level < 2` gate (Pro tier required)
- ✅ `BridgeConfig.enabled` feature flag checked on every operation

---

## 🟢 PASSES — IBEX Tron USDT (ENG-277)

`src/services/bridge/index.ts` → `createVirtualAccount`

The Tron address creation is correctly marked as not implemented:
```typescript
return new Error("IBEX Tron address creation not yet implemented")
```
No partial implementation that could create inconsistent state. Safe to merge in this state as long as the feature flag is off — but ENG-277 needs to be resolved before enabling Bridge in production.

---

## Required Fixes Before Merge

| # | Severity | File | Fix |
|---|----------|------|-----|
| 1 | 🔴 Critical | `src/services/bridge/index.ts` | Validate amount before API call |
| 2 | 🟡 High | `src/services/bridge/index.ts` | Use real user email (ENG-278) |
| 3 | 🟡 High | `src/services/bridge/index.ts` | Return error if external account not found |

---

## Recommendation

Branch is **not ready to merge** until items 1–3 are fixed. Items 1 and 3 are quick fixes (< 1 hour). Item 2 (ENG-278) requires the email lookup, which is a slightly bigger change but the pattern already exists in `business-account-upgrade-request.ts` using `IdentityRepository`.
