# PR #387 Bridge Withdrawal — Merge Conflict Resolution Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Resolve merge conflicts between PR #387 (`eng-273/bridge-dashboard-events`) and the latest `tmp/bridge-rebase-pr-ready` by adding a separate `BridgeWithdrawalRequest` type, updating resolvers to use the correct types, fixing error codes to Bridge-specific codes, and regenerating schemas.

**Architecture:** PR #387 introduces a two-step withdrawal flow (request → confirm/cancel). The base branch now has `BridgeWithdrawal` as the submitted-transfer type (`transferId/state` from ENG-351/353). We keep that contract and create a new `BridgeWithdrawalRequest` type for the pending/request records. We also map `BridgeWithdrawalNotFoundError` and `BridgeWithdrawalAlreadyInitiatedError` to their own Bridge-specific GraphQL error codes instead of generic `VALIDATION_ERROR`.

**Tech Stack:** GraphQL (make-graphql-types), TypeScript, Apollo Federation, Mongoose, jest

**PR Reference:** https://github.com/lnflash/flash/pull/387
**Base Branch:** `tmp/bridge-rebase-pr-ready` (local behind `origin/tmp/bridge-rebase-pr-ready` by 3 commits)

---

## Current State

### Branches Involved

| Branch | `BridgeWithdrawal` fields | Key differences |
|--------|--------------------------|-----------------|
| `origin/tmp/bridge-rebase-pr-ready` (target) | `transferId, amount, currency, state, failureReason, createdAt` | Contract fix from PR #393. Also has ENG-354 KYC ceiling error, ENG-275 deposit notification, ENG-406 USDT LNURL-pay |
| Local `tmp/bridge-rebase-pr-ready` | `id, amount, currency, status, failureReason, createdAt` | **3 commits behind** remote. No contract fix. |
| `pr-387` (FETCH_HEAD) | `id, amount, currency, externalAccountId, status, failureReason, createdAt` | Two-step withdrawal flow. Uses same type for pending requests and submitted transfers. |

### Conflict Files

| File | Conflict Type | Resolution |
|------|--------------|------------|
| `src/graphql/public/types/object/bridge-withdrawal.ts` | Semantic - same type, different shapes | Keep contract version (`transferId/state`). Create new `bridge-withdrawal-request.ts` for request shape. |
| `src/graphql/error-map.ts` | Both added blocks | Merge: keep all PR #393's Bridge-specific codes + add two new withdrawal error codes. |
| `dev/apollo-federation/supergraph.graphql` | Generated artifact | Don't hand-edit. Regenerate with `yarn check:sdl`. |
| `src/graphql/public/schema.graphql` | Generated artifact | Don't hand-edit. Regenerate with `yarn check:sdl`. |
| `docs/bridge-integration/API.md` | Both added content | Merge docs + add new error codes. |

### Service Return Types (from pr-387)

| Service method | Current return shape | Should return |
|----------------|---------------------|---------------|
| `requestWithdrawal` | `{id, amount, currency, externalAccountId, status, failureReason, createdAt}` | Same (BridgeWithdrawalRequest shape) |
| `initiateWithdrawal` | `{id, amount, currency, status, createdAt}` | `{transferId, amount, currency, state, createdAt}` (BridgeWithdrawal shape) |
| `cancelWithdrawalRequest` | `{id, amount, currency, status, createdAt}` | `{id, amount, currency, externalAccountId, status, failureReason, createdAt}` (BridgeWithdrawalRequest shape) |

---

## Phase 1: Update Local Base Branch

**Files:** N/A (git operations only)

**Goal:** Pull the 3 missing commits from `origin/tmp/bridge-rebase-pr-ready` so local base is up to date before rebasing.

### Step 1: Pull remote commits

Run:
```bash
cd /Users/dread/Documents/Island-Bitcoin/Flash/flash
git checkout tmp/bridge-rebase-pr-ready
git pull origin tmp/bridge-rebase-pr-ready
```

Expected: Fast-forward by 3 commits:
- `09644485f` fix(bridge): align GraphQL contract and error codes (#393)
- `963325609` fix(ibex): wire USDT LNURL-pay msat conversion (#389)
- `ca878ae5c` feat(bridge): push notification on deposit settlement [ENG-275] (#392)

### Step 2: Verify base state

Run:
```bash
git log --oneline -5
git show HEAD:src/graphql/public/types/object/bridge-withdrawal.ts
```

Expected: `BridgeWithdrawal` has `transferId, amount, currency, state, failureReason, createdAt`

### Step 3: Create worktree

Run:
```bash
git worktree add /private/tmp/flash-pr387-rebase pr-387
cd /private/tmp/flash-pr387-rebase
```

---

## Phase 2: Add `BridgeWithdrawalRequest` GraphQL Type

**Files:**
- Create: `src/graphql/public/types/object/bridge-withdrawal-request.ts`

### Step 1: Create type file

```typescript
import { GT } from "@graphql/index"

const BridgeWithdrawalRequest = GT.Object({
  name: "BridgeWithdrawalRequest",
  fields: () => ({
    id: { type: GT.NonNullID },
    amount: { type: GT.NonNull(GT.String) },
    currency: { type: GT.NonNull(GT.String) },
    externalAccountId: { type: GT.String },
    status: { type: GT.NonNull(GT.String) },
    failureReason: { type: GT.String },
    createdAt: { type: GT.NonNull(GT.String) },
  }),
})

export default BridgeWithdrawalRequest
```

### Step 2: Add to barrel export

Check `src/graphql/public/types/object/index.ts` or equivalent barrel — add export.

---

## Phase 3: Update Resolvers for Correct Type Assignment

**Files:**
- Modify: `src/graphql/public/root/mutation/bridge-request-withdrawal.ts` (PR #387 version)
- Modify: `src/graphql/public/root/mutation/bridge-cancel-withdrawal-request.ts` (PR #387 version)
- Modify: `src/graphql/public/root/mutation/bridge-initiate-withdrawal.ts` (PR #387 version)
- Modify: `src/graphql/public/root/query/bridge-withdrawal-request.ts` (PR #387 version)
- Modify: `src/graphql/public/mutations.ts`
- Modify: `src/graphql/public/queries.ts`

### Task 3a: `bridge-request-withdrawal.ts`

Change import from `BridgeWithdrawal` to `BridgeWithdrawalRequest`.
Change payload's `withdrawal` field from `type: BridgeWithdrawal` to `type: BridgeWithdrawalRequest`.

### Task 3b: `bridge-cancel-withdrawal-request.ts`

Same pattern — change import and payload field to `BridgeWithdrawalRequest`.

### Task 3c: `bridge-initiate-withdrawal.ts`

PR #387 changed this mutation from the one-step flow (`amount, externalAccountId`) to a two-step flow with `withdrawalId` as input. Return type should be `BridgeWithdrawal` (with `transferId/state`).

Update the `resolve` function's return mapping from:
```typescript
return {
  id: updated.id,
  amount: updated.amount,
  currency: updated.currency,
  status: updated.status,
  createdAt: updated.createdAt.toISOString(),
}
```
to:
```typescript
return {
  transferId: updated.bridgeTransferId,
  amount: updated.amount,
  currency: updated.currency,
  state: updated.status,
  createdAt: updated.createdAt.toISOString(),
}
```

### Task 3d: `bridge-withdrawal-request.ts` (query)

Change return type from `BridgeWithdrawal` to `BridgeWithdrawalRequest`.
The resolver already returns the correct shape (`id, amount, currency, externalAccountId, status, failureReason, createdAt`).

---

## Phase 4: Update Bridge Service Shapes

**Files:**
- Modify: `src/services/bridge/index.ts`

### Task 4a: Update `InitiateWithdrawalResult` type

Change from:
```typescript
type InitiateWithdrawalResult = {
  id: string
  amount: string
  currency: string
  status: string
  createdAt: string
}
```
to:
```typescript
type InitiateWithdrawalResult = {
  transferId: string
  amount: string
  currency: string
  state: string
  createdAt: string
}
```

### Task 4b: Update `initiateWithdrawal()` return mapping

In `initiateWithdrawal()`, change the success return block:
```typescript
return {
  id: updated.id,
  amount: updated.amount,
  currency: updated.currency,
  status: updated.status,
  createdAt: updated.createdAt.toISOString(),
}
```
to:
```typescript
return {
  transferId: updated.bridgeTransferId!,
  amount: updated.amount,
  currency: updated.currency,
  state: updated.status,
  createdAt: updated.createdAt.toISOString(),
}
```

### Task 4c: Update `cancelWithdrawalRequest()` return mapping

Ensure it returns all `BridgeWithdrawalRequest` fields (add `externalAccountId` and `failureReason`):
```typescript
return {
  id: cancelled.id,
  amount: cancelled.amount,
  currency: cancelled.currency,
  externalAccountId: cancelled.externalAccountId,
  status: cancelled.status,
  failureReason: cancelled.failureReason,
  createdAt: cancelled.createdAt.toISOString(),
}
```

### Task 4d: Update `CancelWithdrawalResult` type

Change to include `externalAccountId` and `failureReason`:
```typescript
type CancelWithdrawalResult = {
  id: string
  amount: string
  currency: string
  externalAccountId: string
  status: string
  failureReason?: string
  createdAt: string
}
```

---

## Phase 5: Add Bridge-Specific Error Codes

**Files:**
- Modify: `src/graphql/error-map.ts`
- Modify: `src/graphql/public/schema.graphql` (regenerated later)

### Step 1: Add `BridgeWithdrawalNotFoundError` and `BridgeWithdrawalAlreadyInitiatedError` imports

Add to the import block from `@services/bridge/errors`:
```typescript
import {
  // ...existing imports...
  BridgeWithdrawalNotFoundError,
  BridgeWithdrawalAlreadyInitiatedError,
} from "@services/bridge/errors"
```

### Step 2: Add case handlers in `mapError()`

Add before the `BridgeRateLimitError` case:

```typescript
case "BridgeWithdrawalNotFoundError":
  message = error.message || "Withdrawal request not found"
  return bridgeGqlError({
    code: "BRIDGE_WITHDRAWAL_NOT_FOUND",
    message,
  })

case "BridgeWithdrawalAlreadyInitiatedError":
  message = error.message || "Withdrawal has already been submitted and cannot be cancelled"
  return bridgeGqlError({
    code: "BRIDGE_WITHDRAWAL_ALREADY_INITIATED",
    message,
  })
```

### Step 3: Verify the pattern matches other Bridge-specific codes

Each uses `bridgeGqlError()` with a `BRIDGE_*` code prefix, not `ValidationInternalError`.

---

## Phase 6: Update Tests

**Files:**
- Modify: `test/flash/unit/graphql/bridge-error-map.spec.ts`
- Modify: `test/flash/unit/graphql/public/types/object/bridge-contract.spec.ts`
- Modify: `test/flash/unit/graphql/error-map.spec.ts`

### Task 6a: Add new error codes to bridge-error-map.spec.ts

Add to the `cases` array (from PR #393's test):
```typescript
[new BridgeWithdrawalNotFoundError(), "BRIDGE_WITHDRAWAL_NOT_FOUND"],
[new BridgeWithdrawalAlreadyInitiatedError(), "BRIDGE_WITHDRAWAL_ALREADY_INITIATED"],
```

Also ensure the import block includes these error classes.

### Task 6b: Update bridge-contract.spec.ts

Add a new test block for `BridgeWithdrawalRequest`:
```typescript
import BridgeWithdrawalRequest from "@graphql/public/types/object/bridge-withdrawal-request"

it("exposes withdrawal request fields returned by BridgeService", () => {
  const fields = BridgeWithdrawalRequest.getFields()
  expect(fields).toHaveProperty("id")
  expect(fields).toHaveProperty("amount")
  expect(fields).toHaveProperty("currency")
  expect(fields).toHaveProperty("externalAccountId")
  expect(fields).toHaveProperty("status")
  expect(fields).toHaveProperty("createdAt")
  expect(fields).not.toHaveProperty("transferId")
  expect(fields).not.toHaveProperty("state")
})
```

### Task 6c: Remove or update error-map.spec.ts tests

The existing test in PR #387's `error-map.spec.ts` maps both errors to `VALIDATION_ERROR` — delete those two test cases since they're now covered by `bridge-error-map.spec.ts`.

---

## Phase 7: Regenerate Schema

**Files:**
- Regenerate: `src/graphql/public/schema.graphql`
- Regenerate: `dev/apollo-federation/supergraph.graphql`
- Regenerate: `src/graphql/public/mutations.ts` (auto-updated if needed)
- Regenerate: `src/graphql/public/queries.ts` (auto-updated if needed)

### Step 1: Export new type in barrel

Add `BridgeWithdrawalRequest` to `src/graphql/public/types/object/index.ts` or the appropriate barrel export.

### Step 2: Run SDL check

```bash
yarn check:sdl
```

### Step 3: Verify generated types

Check `src/graphql/public/schema.graphql` for:
- `type BridgeWithdrawalRequest { ... }` with id, amount, currency, externalAccountId, status, failureReason, createdAt
- `BridgeWithdrawal` unchanged with transferId, state
- Payloads reference correct type

Check `dev/apollo-federation/supergraph.graphql` compiled without errors.

---

## Phase 8: Update Documentation

**Files:**
- Modify: `docs/bridge-integration/API.md`

### Step 1: Add new error codes to the Error Codes table

```markdown
| `BRIDGE_WITHDRAWAL_NOT_FOUND` | Withdrawal request record not found. |
| `BRIDGE_WITHDRAWAL_ALREADY_INITIATED` | Withdrawal has already been submitted to Bridge — cannot cancel. |
```

### Step 2: Update withdrawal mutation docs

Update `bridgeRequestWithdrawal` and `bridgeCancelWithdrawalRequest` docs to document `BridgeWithdrawalRequest` return shape instead of `BridgeWithdrawal`.

Update `bridgeWithdrawalRequest` query docs to note it returns `BridgeWithdrawalRequest`.

---

## Phase 9: Validate

### Step 1: Run unit tests

```bash
yarn test test/flash/unit/graphql/bridge-error-map.spec.ts
yarn test test/flash/unit/graphql/public/types/object/bridge-contract.spec.ts
yarn test test/flash/unit/graphql/error-map.spec.ts
yarn test test/flash/unit/services/bridge/index.spec.ts
yarn test test/flash/unit/app/bridge/send-withdrawal-notification.spec.ts
```

Expected: All pass.

### Step 2: Check TypeScript compilation

```bash
npx tsc --noEmit
```

Expected: No errors.

### Step 3: Verify integration

```bash
yarn check:sdl
```

Expected: No diff (schema is already updated).

### Step 4: Commit and push

```bash
git add -A
git commit -m "fix(bridge): resolve PR #387 merge conflicts

- Add BridgeWithdrawalRequest type for pending withdrawal records
- Keep BridgeWithdrawal as submitted-transfer type (transferId/state)
- BridgeWithdrawalNotFoundError/BridgeWithdrawalAlreadyInitiatedError mapped
  to BRIDGE_WITHDRAWAL_NOT_FOUND and BRIDGE_WITHDRAWAL_ALREADY_INITIATED
- Regenerate schema and supergraph
- Update tests and docs"
```

---

## Summary: Files to Create/Modify

| Action | File |
|--------|------|
| CREATE | `src/graphql/public/types/object/bridge-withdrawal-request.ts` |
| MODIFY | `src/graphql/public/root/mutation/bridge-request-withdrawal.ts` |
| MODIFY | `src/graphql/public/root/mutation/bridge-cancel-withdrawal-request.ts` |
| MODIFY | `src/graphql/public/root/mutation/bridge-initiate-withdrawal.ts` |
| MODIFY | `src/graphql/public/root/query/bridge-withdrawal-request.ts` |
| MODIFY | `src/graphql/error-map.ts` |
| MODIFY | `src/services/bridge/index.ts` |
| MODIFY | `test/flash/unit/graphql/bridge-error-map.spec.ts` |
| MODIFY | `test/flash/unit/graphql/public/types/object/bridge-contract.spec.ts` |
| MODIFY | `test/flash/unit/graphql/error-map.spec.ts` |
| REGENERATE | `src/graphql/public/schema.graphql` |
| REGENERATE | `dev/apollo-federation/supergraph.graphql` |
| MODIFY | `docs/bridge-integration/API.md` |

## Errors Encountered
_(None yet)_
