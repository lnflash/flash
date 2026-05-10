# ENG-348 Research Artifact — ERPNext Audit Row Writer for Bridge ↔ IBEX USDT Movements

**Linear:** ENG-348 — `feat(bridge): NEW-ERPNEXT-LEDGER — ERPNext audit-row writer for every Bridge↔IBEX USDT movement`  
**Date:** 2026-05-10  
**Worktree:** `flash/.worktrees/eng-348-prep`  
**Related dependency:** ENG-296 / PR #344 (`eng-296/ibex-usdt-provisioning`)  
**Related downstream observability:** ENG-362 audit-write failure panel

## Executive Summary

ENG-348 should add a finance-facing ERPNext audit surface for every Bridge-backed Cash Wallet USDT movement, written synchronously from the provider webhook handlers.

The strongest v1 shape is **not** a literal ERPNext Journal Entry. It is a dedicated ERPNext DocType named **Bridge Transfer Request** with an idempotent Flash backend upsert writer. This preserves month-over-month finance reporting and traceability without prematurely encoding double-entry accounting policy.

The writer should cover four event paths:

1. Bridge `/deposit` webhook → topup / fiat received.
2. IBEX `/crypto/receive` webhook → topup / settled.
3. Bridge `/transfer` success webhook → cashout / completed.
4. Bridge `/transfer.failed` webhook → cashout / failed.

ERPNext write failures should return `500` from the webhook handler after structured logging, so upstream retries can close gaps and ENG-362 has useful failure signals.

## What We Know So Far

### Ticket scope

From Linear, ENG-348 currently asks for one ERPNext audit row per relevant Bridge ↔ IBEX USDT movement, idempotent on event id, written from webhook handlers in real time. It explicitly excludes reconciliation-gap detection (ENG-276) and Flash-side wallet-ledger credit because IBEX is the ledger.

Acceptance requires:

- exactly one ERPNext row per relevant webhook movement,
- month-over-month reporting possible from ERPNext alone,
- audit-write failures observable on ENG-362.

### Existing Bridge integration state

The Bridge integration branch already has the core primitives ENG-348 needs:

- Bridge API client and service layer.
- Standalone Bridge webhook server.
- Bridge webhook routes for `deposit`, `transfer`, and `kyc`.
- IBEX crypto receive webhook route at `/crypto/receive`.
- Mongo logs for Bridge deposit and IBEX crypto receive events.
- USDT Cash Wallet provisioning assumptions from ENG-296 / PR #344.

Current webhook behavior:

| Source | Current handler | Current side effect | ENG-348 gap |
|---|---|---|---|
| Bridge `/deposit` | `src/services/bridge/webhook-server/routes/deposit.ts` | Idempotency lock + `BridgeDepositLog` | No ERPNext write |
| IBEX `/crypto/receive` | `src/services/ibex/webhook-server/routes/crypto-receive.ts` | Validates USDT/Ethereum, resolves account/wallet, writes `IbexCryptoReceiveLog` | No ERPNext write |
| Bridge `/transfer` | `src/services/bridge/webhook-server/routes/transfer.ts` | Updates withdrawal status to completed/failed | No ERPNext write |

## Recommended Design

### ERPNext object: `Bridge Transfer Request`

Create a normal, non-submittable ERPNext DocType:

- `request_id` — unique deterministic idempotency key.
- `transaction_type` — `Topup` or `Cashout`.
- `status` — `Pending`, `Fiat Received`, `Settled`, `Completed`, `Failed`.
- `provider` — `Bridge`.
- `asset` — `USDT`.
- `network` — currently `Ethereum` in PR #344.
- `amount`, `currency`, `developer_fee`, receipt amounts.
- Flash references: `account_id`, `wallet_id`.
- Provider references: `bridge_customer_id`, `bridge_transfer_id`, `ibex_tx_hash`, `address`.
- Trace fields: `source_systems_seen`, `raw_payload_json`, `first_seen_at`, `last_seen_at`.

### Why this beats Journal Entry for v1

ENG-348 is an audit/reconciliation artifact, not final accounting policy. A dedicated DocType:

- gives Finance a clean reportable table immediately,
- avoids accidental GL semantics before account mappings are signed off,
- supports raw provider trace data better than Journal Entry remarks/custom fields,
- can later feed formal Journal Entries once finance policy is settled.

This still satisfies the ticket’s “ERPNext audit row” intent. If the ticket title’s “Journal Entry” wording is treated as hard acceptance, Dread/Finance should explicitly re-confirm before implementation.

## Event Mapping

### 1. Bridge `/deposit` → Topup / Fiat Received

Current payload shape in route code:

- `event_id`
- `event_object.id`
- `event_object.state`
- `event_object.amount`
- `event_object.currency`
- `event_object.on_behalf_of`
- `event_object.receipt`

Recommended mapping:

| ERPNext field | Source |
|---|---|
| `request_id` | `event_object.id` |
| `transaction_type` | `Topup` |
| `status` | `Fiat Received` when Bridge state indicates received/completed; otherwise `Pending` |
| `bridge_transfer_id` | `event_object.id` |
| `bridge_customer_id` | `event_object.on_behalf_of` |
| `amount`, `currency` | `event_object.amount`, `event_object.currency` |
| receipt fields | `event_object.receipt.*` |
| `source_systems_seen` | include Bridge deposit `event_id` |
| `raw_payload_json` | full webhook payload |

### 2. IBEX `/crypto/receive` → Topup / Settled

Current route validates:

- `tx_hash`
- `address`
- `amount`
- `currency = USDT`
- `network = ethereum`

It resolves account by Ethereum address, persists `IbexCryptoReceiveLog`, finds the USDT wallet, and logs receipt.

Recommended mapping:

| ERPNext field | Source |
|---|---|
| `request_id` | Prefer associated Bridge transfer id if discoverable; v1 fallback `ibex:${tx_hash}` |
| `transaction_type` | `Topup` |
| `status` | `Settled` |
| `account_id` | resolved account id |
| `wallet_id` | resolved USDT wallet id |
| `ibex_tx_hash` | `tx_hash` |
| `address` | receive address |
| `amount` | IBEX amount |
| `asset` | `USDT` |
| `network` | `Ethereum` |
| `source_systems_seen` | include IBEX crypto receive tx hash |
| `raw_payload_json` | full webhook payload |

Open risk: if IBEX payload cannot provide or derive Bridge transfer id, v1 may produce separate `ibex:${tx_hash}` settlement records. ENG-276 can later link them through reconciliation data.

### 3. Bridge `/transfer` success → Cashout / Completed

Current route reads:

- `event`
- `data.transfer_id`
- `data.state`
- `data.amount`
- `data.currency`

Recommended mapping:

| ERPNext field | Source |
|---|---|
| `request_id` | `data.transfer_id` |
| `transaction_type` | `Cashout` |
| `status` | `Completed` |
| `bridge_transfer_id` | `data.transfer_id` |
| `amount`, `currency` | `data.amount`, `data.currency` |
| `source_systems_seen` | include Bridge transfer event id if available, otherwise terminal state marker |
| `raw_payload_json` | full webhook payload |

### 4. Bridge `/transfer.failed` → Cashout / Failed

Same source shape as transfer success, with state/error copied into raw payload.

Recommended mapping:

| ERPNext field | Source |
|---|---|
| `request_id` | `data.transfer_id` |
| `transaction_type` | `Cashout` |
| `status` | `Failed` |
| `bridge_transfer_id` | `data.transfer_id` |
| `amount`, `currency` | `data.amount`, `data.currency` |
| `source_systems_seen` | include Bridge transfer failed marker |
| `raw_payload_json` | full webhook payload including failure reason if present |

## Backend Implementation Shape

Add three backend pieces:

1. `src/services/frappe/models/BridgeTransferRequest.ts`
   - Converts typed internal input into ERPNext field names.
   - Owns defaults and enum normalization.
   - Serializes raw payload JSON.

2. `ErpNext.upsertBridgeTransferRequest(...)`
   - `GET /api/resource/Bridge Transfer Request` filtered by `request_id`.
   - If absent, `POST` new doc.
   - If present, `PUT` changed/merged fields.
   - If create hits unique conflict, re-query and update.
   - Return typed `BridgeTransferRequestUpsertError` on failure.

3. `src/services/frappe/BridgeTransferRequestWriter.ts`
   - Keeps event mapping out of route handlers.
   - Exports:
     - `writeBridgeDepositRequest`
     - `writeIbexCryptoReceiveRequest`
     - `writeBridgeCashoutCompleted`
     - `writeBridgeCashoutFailed`

Routes should call the writer only after existing local persistence/status updates succeed. Duplicate/idempotency paths should continue returning `200` without re-writing ERPNext.

## Idempotency Model

Use two layers:

1. Existing webhook locks prevent duplicate in-process handling.
2. ERPNext `request_id` uniqueness prevents durable duplicate rows and handles replay/race cases.

Suggested `request_id` rules:

| Event | `request_id` |
|---|---|
| Bridge deposit | Bridge transfer id (`event_object.id`) |
| IBEX receive | Bridge transfer id if derivable; otherwise `ibex:${tx_hash}` |
| Bridge transfer completed | Bridge transfer id |
| Bridge transfer failed | Bridge transfer id |

Track event-level replay metadata in `source_systems_seen` rather than creating multiple rows per event id. That lets one logical request accumulate Bridge + IBEX facts over time.

## Failure Behavior

ERPNext write failure should be treated as a webhook processing failure:

- log structured error fields,
- return `500`,
- rely on upstream webhook retry,
- expose logs/metrics for ENG-362.

Minimum structured log fields:

- `request_id`
- `transaction_type`
- `provider_event_id`
- `bridge_transfer_id`
- `ibex_tx_hash`
- `account_id`
- `wallet_id`
- ERPNext response body/exception where safe.

Do not silently skip ERPNext when configured. If the ERPNext client is missing in an environment where Bridge is enabled, return a typed failure.

## Open Questions

1. **DocType vs Journal Entry final sign-off:** research recommends DocType. Ticket wording still mentions Journal Entry/audit row. Need finance/Dread confirmation if this distinction matters for acceptance.
2. **Network naming:** PR #344 route currently validates `network=ethereum`, while earlier Bridge docs discuss Tron/TRC-20. ENG-348 should follow PR #344’s actual IBEX Cash Wallet path unless ENG-296 changes it again.
3. **IBEX ↔ Bridge join key:** can IBEX `/crypto/receive` payload include Bridge transfer id or destination tx hash that matches Bridge receipt? If no, v1 may produce `ibex:${tx_hash}` records and ENG-276 links later.
4. **Event id availability for transfer webhooks:** current route uses `event` + `data.transfer_id`, not `event_id`. If Bridge includes event ids in production payloads, capture them in raw/source metadata.
5. **ERPNext field types:** amounts should likely be Data/string-compatible decimals initially to avoid precision loss across USDT/fiat fields.

## Recommended Acceptance Criteria Rewrite

ENG-348 should be considered done when:

- ERPNext has a `Bridge Transfer Request` DocType with unique `request_id` and reportable core fields.
- Bridge deposit, IBEX crypto receive, Bridge transfer completed, and Bridge transfer failed handlers call the writer after existing local persistence/status updates.
- Duplicate webhooks do not create duplicate ERPNext rows.
- ERPNext write failures return webhook `500` and emit structured logs for ENG-362.
- Focused unit tests cover model mapping, ERPNext upsert create/update/conflict/failure, and route wiring failure behavior.

## Source Evidence

- Linear ENG-348 current description and historical comment, fetched 2026-05-10.
- Existing design doc: `docs/plans/2026-05-09-eng-348-erpnext-bridge-transfer-request-design.md`.
- Existing implementation plan: `docs/plans/2026-05-09-eng-348-erpnext-bridge-transfer-request.md`.
- Bridge deposit route: `src/services/bridge/webhook-server/routes/deposit.ts`.
- Bridge transfer route: `src/services/bridge/webhook-server/routes/transfer.ts`.
- IBEX crypto receive route: `src/services/ibex/webhook-server/routes/crypto-receive.ts`.
- ERPNext client precedent: `src/services/frappe/ErpNext.ts`.
- Existing logs: `src/services/mongoose/bridge-deposit-log.ts`, `src/services/mongoose/ibex-crypto-receive-log.ts`.
