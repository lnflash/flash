# ENG-348 ERPNext Bridge Transfer Request Design

**Goal:** Write a finance-facing ERPNext record for each Bridge-backed Cash Wallet topup/cashout request, with durable idempotency and enough trace data for month-over-month reconciliation.

**Linear:** ENG-348 — `feat(bridge): NEW-ERPNEXT-LEDGER — ERPNext audit-row writer for every Bridge↔IBEX USDT movement`

**Base:** PR #344 / `eng-296/ibex-usdt-provisioning`, because ENG-348 depends on real ETH-USDT Cash Wallet provisioning and the updated IBEX `/crypto/receive` route.

---

## Decision Summary

Create a normal ERPNext DocType named **Bridge Transfer Request**.

This DocType represents the Flash business object, not the low-level provider event. A Bridge transfer request may be a:

- **Topup** — user buys Cash Wallet value through Bridge on-ramp.
- **Cashout** — user sells/withdraws Cash Wallet value through Bridge off-ramp.

The DocType should be normal/editable ERPNext data with read-only fields where practical. It should not use Journal Entry semantics and should not require submit/cancel workflow in v1.

## Why Not Journal Entry

ENG-348 needs an audit and reconciliation surface, not double-entry accounting behavior. Journal Entry would force accounting semantics before finance policy is settled and would make provider webhook data harder to report on directly.

A dedicated DocType gives Finance a clean Flash-native report while preserving technical traceability to Bridge, IBEX, and webhook payloads.

## Data Model

### DocType

`Bridge Transfer Request`

### Core Fields

| Field | Type | Notes |
|---|---|---|
| `request_id` | Data | Unique deterministic id for the logical request. Prefer Bridge transfer id when available; for IBEX-only settlement events, derive from tx hash. |
| `transaction_type` | Select | `Topup`, `Cashout`. |
| `status` | Select | Flash-normalized state. Suggested: `Pending`, `Fiat Received`, `Settled`, `Completed`, `Failed`. |
| `provider` | Select | `Bridge` for v1. |
| `asset` | Data/Select | `USDT` for v1. |
| `network` | Data/Select | `Ethereum` for v1. |
| `amount` | Currency/Data | Store provider amount as string-compatible decimal if precision risk exists. |
| `currency` | Data/Select | Provider currency, e.g. `USDT`, `USD`. |
| `developer_fee` | Currency/Data | Bridge fee when available. |
| `initial_amount` | Currency/Data | From Bridge receipt. |
| `subtotal_amount` | Currency/Data | From Bridge receipt. |
| `final_amount` | Currency/Data | From Bridge receipt. |
| `account_id` | Data | Flash account id. |
| `wallet_id` | Data | Flash/IBEX USDT wallet id when known. |
| `bridge_customer_id` | Data | Bridge customer id / `on_behalf_of`. |
| `bridge_transfer_id` | Data | Bridge transfer id. |
| `ibex_tx_hash` | Data | Ethereum tx hash from IBEX receive. |
| `address` | Data | Ethereum receive address. |
| `source_systems_seen` | Small Text / JSON | Track which provider events have contributed: Bridge deposit, IBEX receive, Bridge transfer complete/failed. |
| `raw_payload_json` | Code / Long Text | Last or merged raw payload JSON for triage. |
| `first_seen_at` | Datetime | First webhook/process time. |
| `last_seen_at` | Datetime | Last webhook/process time. |

### Idempotency

Use `request_id` as the primary logical idempotency key.

For event-level replay safety, also track provider event identifiers in `source_systems_seen` / event metadata:

- Bridge deposit: `event_id` + Bridge transfer id/state.
- Bridge transfer completed/failed: `event_id` if present, otherwise Bridge transfer id + terminal event.
- IBEX crypto receive: `tx_hash`.

The backend writer should perform an upsert-like operation:

1. Find `Bridge Transfer Request` by `request_id`.
2. If absent, create it.
3. If present, merge only new data/state transitions.
4. If the exact provider event was already applied, return duplicate/no-op success.

ERPNext should enforce uniqueness on `request_id`.

## Event Mapping

### Bridge `/deposit`

**Source file:** `src/services/bridge/webhook-server/routes/deposit.ts`

Current PR #344 payload shape:

- `event_id`
- `event_object.id`
- `event_object.state`
- `event_object.amount`
- `event_object.currency`
- `event_object.on_behalf_of`
- `event_object.receipt`

Mapping:

- `transaction_type`: `Topup`
- `status`: `Fiat Received` or `Pending`, depending on Bridge state
- `request_id`: `event_object.id`
- `bridge_transfer_id`: `event_object.id`
- `bridge_customer_id`: `event_object.on_behalf_of`
- receipt fields copied from `event_object.receipt`

### IBEX `/crypto/receive`

**Source file:** `src/services/ibex/webhook-server/routes/crypto-receive.ts`

Current PR #344 behavior:

- validates `currency=USDT`, `network=ethereum`
- finds account by `bridgeEthereumAddress`
- writes `IbexCryptoReceiveLog`
- finds USDT wallet
- logs receipt

Mapping:

- `transaction_type`: `Topup`
- `status`: `Settled`
- `request_id`: prefer associated Bridge transfer id if discoverable later; v1 fallback `ibex:${tx_hash}`
- `account_id`: resolved account id
- `wallet_id`: resolved USDT wallet id
- `ibex_tx_hash`: `tx_hash`
- `address`: receive address
- `asset`: `USDT`
- `network`: `Ethereum`

Note: if Bridge transfer id is not available on the IBEX payload, v1 may create a separate settlement record keyed by tx hash. A follow-up can link Bridge and IBEX rows when reconciliation data exists.

### Bridge `/transfer` — Completed

**Source file:** `src/services/bridge/webhook-server/routes/transfer.ts`

Mapping:

- `transaction_type`: `Cashout`
- `status`: `Completed`
- `request_id`: Bridge transfer id
- `bridge_transfer_id`: Bridge transfer id
- amount/currency copied from payload

### Bridge `/transfer` — Failed

Mapping:

- `transaction_type`: `Cashout`
- `status`: `Failed`
- `request_id`: Bridge transfer id
- `bridge_transfer_id`: Bridge transfer id
- state/error data copied from payload/raw JSON

## Backend Components

### ERPNext model

Add a backend model, likely:

- `src/services/frappe/models/BridgeTransferRequest.ts`

Responsibilities:

- Validate required fields.
- Convert internal input to ERPNext payload.
- Normalize enums and timestamps.

### ERPNext client method

Add to `src/services/frappe/ErpNext.ts`:

- `upsertBridgeTransferRequest(input)`

Recommended implementation:

1. GET `/api/resource/Bridge Transfer Request` with filter on `request_id`.
2. If absent, POST a new doc.
3. If present, PUT/PATCH fields that changed.
4. Treat uniqueness conflict on create as duplicate race: re-query and merge.

### Audit writer service

Add a small service that maps webhook/provider payloads into the model:

- `src/services/frappe/BridgeTransferRequestWriter.ts`

Export functions such as:

- `writeBridgeDepositRequest(payload)`
- `writeIbexCryptoReceiveRequest(payload)`
- `writeBridgeCashoutCompleted(payload)`
- `writeBridgeCashoutFailed(payload)`

Keep mapping out of route handlers so route code stays readable and tests are focused.

## Failure Behavior

If the ERPNext write fails, the webhook handler should return `500` after logging structured fields. This preserves upstream retry behavior and prevents silent finance gaps.

Log fields should include:

- `request_id`
- `transaction_type`
- `provider_event_id`
- `bridge_transfer_id`
- `ibex_tx_hash`
- `account_id`
- ERPNext error body/exception where safe

These logs are the input for ENG-362’s ERPNext audit failure panel.

## Out of Scope

- Reconciliation-gap detection: ENG-276.
- User push notifications: ENG-275.
- Flash-side USDT wallet ledger credit/debit: not applicable; IBEX is the ledger.
- Full accounting Journal Entry posting.
- Historical backfill, unless separately requested.

## Test Strategy

### Frappe app

- Add DocType JSON for `Bridge Transfer Request`.
- Add a minimal controller if needed.
- Add tests/fixtures for required fields and unique `request_id` where practical.

### Flash backend

- Unit test DocType payload conversion.
- Unit test ERPNext upsert behavior:
  - create new request
  - merge existing request
  - duplicate conflict re-query
  - failure returns typed error
- Unit test webhook route integration with mocked writer:
  - Bridge deposit writes `Topup`
  - IBEX receive writes settled `Topup`
  - Bridge transfer completed writes `Cashout` completed
  - Bridge transfer failed writes `Cashout` failed
  - writer failure returns 500

## Open Questions / Future Enhancements

1. Whether IBEX crypto receive payload can include or derive Bridge transfer id. If not, v1 may create `ibex:${tx_hash}` settlement records and ENG-276 can later link them.
2. Whether Finance wants additional report views or dashboards inside ERPNext after the DocType exists.
3. Whether v2 should add a child table for provider events instead of storing event metadata JSON.
