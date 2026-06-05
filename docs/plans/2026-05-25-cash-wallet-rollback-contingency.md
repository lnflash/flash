# ENG-364 Cash Wallet Cutover Rollback Contingency Plan

**Goal:** Define decision criteria, sequencing, runbook, comms, and prerequisite engineering work for rolling back the Cash Wallet cutover (IBEX ETH-USDT -> IBEX USD).

**Status:** Planning document. The current code on `origin/tmp/bridge-rebase-pr-ready` has forward cutover support, but rollback is not executable yet because the rollback handlers, operator endpoint, and batch queries do not exist.

**Verified against:** `origin/tmp/bridge-rebase-pr-ready`.

---

## 1. Code Reality Check

This plan is grounded in the cutover code under `src/app/cash-wallet-cutover/` on `origin/tmp/bridge-rebase-pr-ready`.

### State machine and executor

- `src/app/cash-wallet-cutover/index.types.d.ts` defines migration statuses including `rollback_started` and `rolled_back`.
- `src/app/cash-wallet-cutover/state-machine.ts` allows only one rollback transition today: `rollback_started -> rolled_back` or `rollback_started -> failed`.
- No existing forward state transitions to `rollback_started`; every rollback entry transition must be added intentionally.
- `src/app/cash-wallet-cutover/executor.ts` defines `RunnableCashWalletMigrationStatus` by excluding `complete`, `failed`, `requires_operator_review`, `skipped_already_migrated`, `rollback_started`, and `rolled_back`.
- The executor's `terminalStatuses` also includes `rollback_started` and `rolled_back`, so `executeCashWalletMigrationStep` returns those records unchanged. `rollback_started` is not runnable by the current worker.

**Implication:** rollback handlers do not exist. Every per-state rollback handler must be built from scratch; adding the status values alone does not make rollback run.

### Guard and presentation behavior

`src/app/cash-wallet-cutover/guard.ts` defines `ACTIVE_STATUSES` as:

```ts
[
  "started",
  "provisioned",
  "balance_read",
  "invoice_created",
  "balance_move_sending",
  "balance_move_sent",
  "balance_move_verified",
  "fee_reimbursement_invoice_created",
  "fee_reimbursement_sending",
  "fee_reimbursed",
  "pointer_flipped",
  "rollback_started",
]
```

`rolled_back` is **not** in `ACTIVE_STATUSES`.

`evaluateCashWalletCutoverGuard` returns:

- `legacy_usd` when global state is `pre`
- `usdt` when global state is `complete`
- `legacy_usd` when there is no migration or status is `not_started`
- `usdt` when status is `complete` or `skipped_already_migrated`
- `CashWalletMigrationFailedError` for `failed` or `requires_operator_review`
- `CashWalletCutoverInProgressError` for `ACTIVE_STATUSES`
- `legacy_usd` by final fallback

**Implication:** during `in_progress`, a `rolled_back` migration falls through to `legacy_usd` correctly. Rollback does not need to "explicitly clean the presentation state" to unblock presentation. It does need to set the account pointer and balances correctly before marking `rolled_back`.

`evaluateCashWalletCutoverPresentation` calls the guard first. For a `rolled_back` migration during global `in_progress`, it returns `{ presentation: "legacy_usd" }`. If the global config is still `complete`, the guard returns `usdt` before inspecting migration state, so full rollback must set global state back to `pre` or introduce a formal rollback config state.

### GraphQL config state

`src/graphql/shared/types/scalar/cash-wallet-cutover-state.ts` exposes only these GraphQL enum values:

```graphql
enum CashWalletCutoverState {
  PRE
  IN_PROGRESS
  COMPLETE
}
```

Their internal values are `"pre"`, `"in_progress"`, and `"complete"` respectively. There is no `ROLLED_BACK` config state.

The admin mutation exists at `src/graphql/admin/root/mutation/cash-wallet-cutover-update.ts`:

```graphql
mutation CashWalletCutoverUpdate($input: CashWalletCutoverUpdateInput!) {
  cashWalletCutoverUpdate(input: $input) {
    errors { message }
    cashWalletCutover { state }
  }
}
```

`CashWalletCutoverUpdateInput` supports `state`, `scheduledAt`, `cutoverVersion`, `runId`, and `pauseReason`.

### Migration record and pointer fields

`previousDefaultWalletId` exists on the migration record type:

- `src/app/cash-wallet-cutover/index.types.d.ts`
- `src/services/mongoose/schema.types.d.ts`
- `src/services/mongoose/schema.ts`
- `src/services/mongoose/cash-wallet-cutover.ts`

It is written when `flipCashWalletMigrationDefaultPointer` runs in `src/app/cash-wallet-cutover/worker.ts`. The runtime pointer service in `src/app/cash-wallet-cutover/runtime-services.ts` reads `account.defaultWalletId` before calling `updateDefaultWalletId`, then patches the migration with that previous value.

`previousDefaultWalletId` is not currently exposed in the admin GraphQL cutover type, so an operator rollback flow cannot rely on GraphQL alone to read it yet.

### Conversion constant

`src/app/cash-wallet-cutover/amount-conversion.ts` defines:

```ts
const USDT_MICROS_PER_USD_CENT = 10_000n
```

The type is `bigint`. `usdCentsToUsdtMicros` multiplies string-encoded USD cents by `10_000n`; `usdtMicrosToUsdCentsCeil` divides with ceiling.

### Default wallet pointer

`src/app/accounts/update-default-walletid.ts` can set `account.defaultWalletId` to any wallet ID owned by the account. It validates ownership with `WalletsRepository().listByAccountId(account.id)` and `wallets.some((w) => w.id === walletId)`. It does not require the wallet to be a USDT wallet. A rollback handler can flip back to the legacy USD wallet ID as long as that wallet still belongs to the account.

### Reverse payment shape

The current payment primitive is `Ibex.payInvoice` / `payInvoiceV2`, wrapped by `paymentService.payInvoice` in `src/app/cash-wallet-cutover/runtime-services.ts`. It pays **from** `senderWalletId` / `accountId` **to** a Bolt11 invoice.

Forward migration creates a no-amount invoice on `destinationUsdtWalletId` via `createNoAmountInvoice`, then pays that invoice from `legacyUsdWalletId` with `senderAmountUsdCents`.

**Implication:** reversing the migration is not a direct "send to wallet" call. The operator flow must create an invoice on the legacy USD wallet, then pay that invoice from the USDT wallet. That pattern must be implemented and documented in the rollback operator endpoint.

---

## 2. Architecture Summary

The forward cutover migrates each account's default Cash Wallet from IBEX USD to an IBEX USDT wallet. The current forward flow is:

1. Global config transitions `pre -> in_progress -> complete`.
2. Per-account migration follows `not_started -> started -> provisioned -> balance_read -> invoice_created -> balance_move_sending -> balance_move_sent -> balance_move_verified -> [fee_reimbursement_invoice_created -> fee_reimbursement_sending -> fee_reimbursed] -> pointer_flipped -> legacy_zero_verified -> complete`.
3. `evaluateCashWalletCutoverPresentation` masks the migration for old clients. USDT-capable clients see USDT; old clients may see `legacy_usd_compat` backed by USDT after a completed migration.

### What rollback must undo

| Migration Step | Rollback Action | Complexity |
|---|---|---|
| `not_started` through `balance_read` | Nothing committed; mark `rolled_back` only after adding legal transition support | Low |
| `invoice_created` | Invoice exists, but no payment has necessarily moved; verify invoice/payment status before marking rollback | Low |
| `balance_move_sending` through `balance_move_verified` | Funds may have moved from legacy USD wallet to USDT wallet via Lightning | Medium; reverse payment required |
| `fee_reimbursement_*` | Treasury may have sent sats/USDT to cover shortfall | High; requires accounting treatment and explicit policy |
| `pointer_flipped` | Account default changed from USD to USDT | Medium; flip back using `previousDefaultWalletId` or `legacyUsdWalletId` |
| `legacy_zero_verified` | Legacy USD wallet confirmed zero after forward move | Full reverse |
| `complete` | All forward steps done | Full reverse |
| `failed` / `requires_operator_review` | Account blocked mid-migration | Manual review |
| `skipped_already_migrated` | Account was already on USDT before cutover | Do not roll back to USD; leave in USDT |
| `rollback_started` | Current executor excludes this status | Needs custom rollback executor/handler |
| `rolled_back` | Presentation falls back to legacy USD during `in_progress` | Terminal rollback marker |

### `skipped_already_migrated` edge case

Accounts marked `skipped_already_migrated` were already using USDT before this cutover run. They do not have a pre-cutover USD default pointer to restore. The rollback process must skip them and leave them in USDT. They should not count as rollback failures.

---

## 3. Decision Matrix

### Trigger Conditions

| Condition | Action | Decision-Maker |
|---|---|---|
| >5% of migrated accounts report missing balance after pointer flip | Immediate full rollback decision | Dread |
| Operator detects incorrect balance in 2+ accounts during verification | Pause and inspect; rollback if confirmed | Operator on-call |
| Core GraphQL wallet mutation latency increases >2x for wallet operations | Pause and inspect | Operator on-call |
| USDT mint/IBEX API unavailable for >15 min during active migration window | Pause; resume when API recovers | Operator on-call |
| Any account shows >$1 discrepancy between migrated amount and post-migration balance | Roll back that account only | Operator on-call |
| Cutover complete but >0.1% of accounts have fallen through to error fallback | Full rollback decision within window | Dread |

### Decision Windows

| Cutover State | Window | Notes |
|---|---|---|
| `in_progress`, no accounts past `pointer_flipped` | No hard deadline | Individually reversible after handlers exist |
| `in_progress`, some `pointer_flipped` or `complete` | T+24h | New USDT transactions may settle after pointer flip |
| `complete` globally | T+72h | After this, rollback becomes incident-scale reconciliation |

### Point of No Return

Rollback is not viable as a routine operation after T+72h from global cutover completion. At that point:

- New user activity may have settled into USDT wallets.
- Post-migration deposits are not tracked on the migration record.
- Old USD wallets may have changed operational status.
- Reverse conversion can become lossy because `usdtMicrosToUsdCentsCeil` rounds up.

---

## 4. Implementation Prerequisites

The following work must be built before this plan is executable in production:

| Prerequisite | Why it is required |
|---|---|
| Rollback handlers for each state | `rollback_started` and `rolled_back` exist as statuses, but `executeCashWalletMigrationStep` excludes them. Handlers and legal transitions from forward states into rollback must be implemented. |
| Reverse payment operator endpoint | IBEX only exposes a pay-from-wallet pattern through `payInvoice`; rollback needs an endpoint that creates an invoice on the legacy USD wallet and pays it from the USDT wallet. |
| `previousDefaultWalletId` read access in admin GraphQL | The field exists in storage, but operators need to inspect it without direct database access. |
| Batch rollback repository query | `CashWalletCutoverRepository` has `listRunnableMigrations` and `countByStatus`, but no query for "all completed/pointer-flipped migrations for run X that require rollback." |
| Extend `CashWalletCutoverState` enum or define rollback terminal convention | GraphQL supports only `PRE`, `IN_PROGRESS`, and `COMPLETE`. Either add `ROLLED_BACK` or formally define `PRE` as the terminal global rollback state with audit metadata elsewhere. |
| Admin rollback mutation/tool | Needed for idempotent single-account and full-run rollback. |
| Staging rehearsal data and scripts | Required to measure per-account timings and validate reverse payment behavior. |

---

## 5. Rollback Modes

### 5A. Partial Rollback: Single Account

Use when one account has an incorrect balance or blocked migration.

**Trigger:** Operator identifies a specific migration record that must be reversed.

**Runbook after prerequisites exist:**

1. Fetch migration by `accountId`, `cutoverVersion`, and `runId`.
2. If status is `skipped_already_migrated`, stop. The account was already USDT before cutover and stays in USDT.
3. If funds may have moved (`balance_move_sending` or later), inspect current legacy USD and destination USDT balances plus payment transaction IDs.
4. Create a reverse invoice on `legacyUsdWalletId`.
5. Pay the reverse invoice from `destinationUsdtWalletId`.
6. If the pointer was flipped, call `updateDefaultWalletId({ accountId, walletId: previousDefaultWalletId ?? legacyUsdWalletId })`.
7. Mark migration `rolled_back`.
8. Verify `evaluateCashWalletCutoverPresentation` returns `legacy_usd` while global state is `in_progress` or `pre`.

**Estimated time:** 10-30 min per account manually. Target for tooling should be <=2 min per account.

### 5B. Pause Migration: Mid-Flight

Use when all forward progress needs to stop without reversing completed migrations.

**Runbook:**

1. Set cutover config state to `IN_PROGRESS` with a `pauseReason`.
2. Stop the migration worker if it is running as a recurring job.
3. Confirm no new migrations are starting by checking per-status counts.
4. Investigate the trigger condition.

**Resuming:** clear `pauseReason`, restart the worker, and confirm migrations resume.

### 5C. Full Rollback: Pre-Global-Complete

Use when global state is still `in_progress` and the rollout must abort.

**Preconditions:**

- Cutover config state is `IN_PROGRESS`, not `COMPLETE`.
- Worker is stopped.
- Rollback handlers and reverse payment endpoint are available.

**Runbook:**

1. Lock the worker path so no forward migration can run.
2. Update cutover config with `state: IN_PROGRESS` and `pauseReason: "rollback-underway"`.
3. Query all migrations in the run that are not terminal rollback/skipped states.
4. For each account:
   - `skipped_already_migrated`: skip and leave in USDT.
   - Before payment movement: mark `rolled_back` after valid rollback transition.
   - After payment movement: reverse funds by invoice-on-USD/pay-from-USDT, then mark `rolled_back`.
   - After pointer flip: reverse funds, flip pointer back, then mark `rolled_back`.
5. Set global state to `PRE`, unless a formal `ROLLED_BACK` state has been implemented.
6. Run discovery and presentation checks.

**Estimated time:** use measured staging timing. At a conservative 2 min per account, 100 accounts take about 3h20m and 1,000 accounts take about 33h20m. Full rollback must be batchable and parallelized before it is a realistic large-run option.

### 5D. Full Rollback: Post-Global-Complete

Use after global state reached `COMPLETE`, within the T+72h window.

**Preconditions:**

- Cutover config state is `COMPLETE`.
- Within 72h of `completedAt`.
- Cash Wallet writes can be paused or routed safely.
- Tooling can distinguish migrated funds from post-migration activity.

**Runbook:**

1. Notify stakeholders.
2. Stop Cash Wallet writes or route them to a safe maintenance path.
3. Move global state away from `COMPLETE` before relying on per-account presentation. In current code, `evaluateCashWalletCutoverGuard` returns `usdt` immediately for global `complete`.
4. For each migration:
   - `complete`, `legacy_zero_verified`, `pointer_flipped`, or other post-payment status: reverse eligible funds, flip pointer back, mark `rolled_back`.
   - `failed` or `requires_operator_review`: review manually.
   - `skipped_already_migrated`: skip and leave in USDT.
5. Set global terminal state to `PRE` unless `ROLLED_BACK` has been implemented.
6. Restore write access after verification.
7. Compare aggregate balances against pre-cutover totals and staging rehearsal tolerances.

**Important balance-computation caveat:** `previousDefaultWalletId` exists, and `destinationStartingBalanceUsdtMicros` / `destinationAmountUsdtMicros` exist, but post-migration deposits and withdrawals are not tracked on the migration record. A formula such as `currentUsdtBalance - destinationStartingBalanceAtMigration - postMigrationDeposits` is aspirational until there is a reliable way to compute post-migration activity from ledger/IBEX transaction history. This needs a separate design before post-global-complete rollback can be automated.

**Estimated time:** not realistically 2-4h for large batches without parallel tooling. At 2 min/account, 1,000 accounts take about 33h20m serially. A production full rollback needs a tested concurrency limit, retry policy, and reconciliation process.

---

## 6. Staging Dry-Run Procedure

Before production cutover day, run rollback in staging after implementing the prerequisites.

### Steps

1. Set up staging with at least 10 representative accounts across the migration state machine, including `skipped_already_migrated`.
2. Run a forward cutover to completion.
3. Trigger rollback scenarios:
   - Single account with simulated balance discrepancy.
   - Full rollback from `in_progress` with accounts past `balance_move_sent`.
   - Full rollback from `complete` with a known post-migration deposit case.
4. Time each phase and record per-account duration.
5. Verify:
   - Eligible accounts return to pre-migration `defaultWalletId`.
   - `skipped_already_migrated` accounts remain in USDT.
   - Balance sums match expected totals within conversion tolerance.
   - Old clients see the expected legacy USD presentation after rollback.
   - New clients do not see stale USDT presentation for rolled-back accounts while global state is `pre` or `in_progress`.
6. Update timings in this document.

### Success Criteria

- Single-account rollback is idempotent.
- Batch rollback can resume after interruption.
- Reverse payments are traceable by account, migration ID, run ID, and operator.
- No account has irreconcilable balance after reverse.
- Unexpected states fail closed into operator review.

---

## 7. Comms Plan

### Internal: Operator Channel

```text
[CUTOVER-ROLLBACK] Initiating Cash Wallet rollback.
Trigger: {{trigger_reason}}
Mode: {{single_account|full_run}}
Expected duration: {{estimate}}
Cutover version: {{cutoverVersion}}
Run: {{runId}}
Cash Wallet writes: {{paused|restricted|normal}}
Operator: {{operator}}
```

### Support

```text
We are rolling back part of the Cash Wallet migration.
Some Cash Wallet operations may be temporarily delayed.
Route escalated reports to #ops with account ID, timestamp, and user-visible balance.
```

### User-Facing, if rollback affects users for more than 4h

```text
Subject: Update on your Flash Cash Wallet

We are reverting a recent Cash Wallet system migration after detecting an issue in post-migration checks. Your balance will be reconciled as part of the rollback. No action is needed from you.

If you have questions, contact support@getflash.io.
```

---

## 8. Rollback API / Operator Tooling

### Existing admin mutation

```graphql
mutation CashWalletCutoverUpdate($input: CashWalletCutoverUpdateInput!) {
  cashWalletCutoverUpdate(input: $input) {
    errors { message }
    cashWalletCutover {
      state
      cutoverVersion
      runId
      pauseReason
    }
  }
}
```

Supported state values are `PRE`, `IN_PROGRESS`, and `COMPLETE`. There is no `ROLLED_BACK` state today.

### Required rollback mutation

```graphql
mutation CashWalletCutoverRollback($input: CashWalletCutoverRollbackInput!) {
  cashWalletCutoverRollback(input: $input) {
    errors { message }
    rollbackSummary {
      accountsReversed
      accountsSkipped
      accountsFailed
      totalDurationMs
      totalAmountReversedUsdCents
      totalAmountReversedUsdtMicros
    }
  }
}

input CashWalletCutoverRollbackInput {
  accountId: AccountId
  runId: String
  mode: CashWalletCutoverRollbackMode!
  dryRun: Boolean
}

enum CashWalletCutoverRollbackMode {
  SINGLE_ACCOUNT
  FULL_RUN
}
```

### Required operator behavior

- Dry-run must report accounts by current migration status before any mutation.
- Single-account rollback must be idempotent.
- Full-run rollback must be resumable.
- Each reverse payment must log `actor`, `accountId`, `migrationId`, `runId`, `fromWalletId`, `toWalletId`, `amountReversed`, `paymentHash`, `transactionId`, and timestamp.
- Reverse payment must create the invoice on the legacy USD wallet and pay it from the USDT wallet.

---

## 9. Guardrails

- Do not expose rollback operations in the public GraphQL schema; admin schema only.
- Do not assume `rollback_started` will be picked up by the existing executor. It is explicitly excluded from `RunnableCashWalletMigrationStatus`.
- Do not mark an account `rolled_back` until funds and pointer state are already restored or proven unchanged.
- Do not roll back `skipped_already_migrated` accounts to USD. They had no pre-cutover USD default pointer for this run and should remain USDT.
- Do not rely on `previousDefaultWalletId` through admin GraphQL until the field is exposed there.
- Do not use global `COMPLETE` during rollback presentation checks. Current guard logic returns USDT immediately for global `complete`.
- `rolled_back` is not in `ACTIVE_STATUSES`; it does not block writes through the in-progress guard. The blocking rollback status is `rollback_started`.
- Use the existing conversion ratio from `USDT_MICROS_PER_USD_CENT = 10_000n`. Do not introduce a conflicting reverse constant.
- Keep rollback changes scoped to cutover app logic, admin GraphQL, repository access, and operator tooling.
