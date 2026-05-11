# Bridge–IBEX Reconciliation System

## Overview

The reconciliation system ensures every USD deposit processed by **Bridge.xyz** has a corresponding **IBEX** crypto receive event, and vice versa. A deposit flows through two independent systems:

1. **Bridge.xyz** receives the USD bank wire, converts it to USDT, and sends it on-chain to the IBEX address. Bridge fires one webhook per state transition — reconciliation only triggers on the final `payment_processed` state, which is when the `destinationTxHash` (the on-chain USDT tx hash) is present.
2. **IBEX** detects the on-chain USDT receive at that address and notifies us via webhook (`crypto.receive` + `txHash`).

Both webhooks should arrive for every deposit. The reconciliation system detects when one side is missing — either Bridge confirmed but IBEX never fired, or IBEX fired but no matching Bridge event was logged.

---

## Two Reconciliation Modes

### 1. Real-time (event-driven) — added in this PR

Fires automatically on every webhook arrival. Zero wait time.

### 2. Batch (safety net) — pre-existing

Runs via the cron job, comparing all events in a sliding time window (default **15 minutes**). Catches anything the real-time path might have missed (e.g. a webhook that was processed out of order or after a server restart). The window only needs to be as large as the cron interval — real-time handles everything else instantly.

---

## End-to-End Flow

```
USD bank wire
      │
      ▼
Bridge.xyz API
      │ (converts USD → USDT, sends on-chain)
      │
      ├──── Bridge webhook ──────────────────────────────────────────────┐
      │     POST /webhooks/deposit  (fires 4 times per deposit)          │
      │     awaiting_funds → funds_received → payment_submitted          │
      │                                     → payment_processed ✓        │
      │     receipt.destination_tx_hash only present at payment_processed│
      │                                                                  ▼
      │                                         src/services/bridge/webhook-server/routes/deposit.ts
      │                                           1. Validates + deduplicates (lock on transferId:state)
      │                                           2. createBridgeDepositLog() → MongoDB BridgeDepositLog
      │                                           3. If state=payment_processed && destinationTxHash:
      │                                              → reconcileByTxHash({ txHash }) [non-blocking]
      │
      ▼
IBEX detects on-chain receive
      │
      ├──── IBEX webhook ────────────────────────────────────────────────┐
      │     POST /webhooks/ibex/crypto/receive                           │
      │     tx_hash: "0xabc..."                                          │
      │                                                                  ▼
      │                                         src/services/ibex/webhook-server/routes/crypto-receive.ts
      │                                           1. Validates payload (USDT, tron)
      │                                           2. Looks up account by Ethereum address
      │                                           3. createIbexCryptoReceiveLog() → MongoDB IbexCryptoReceiveLog
      │                                           4. reconcileByTxHash({ txHash }) [non-blocking]
      │
      ▼
reconcileByTxHash()  ──  src/services/bridge/reconciliation.ts
      │
      ├── Queries in parallel:
      │     BridgeDepositLog.findOne({ destinationTxHash: txHash, state: "payment_processed" })
      │     IbexCryptoReceiveLog.findOne({ txHash })
      │
      ├── BOTH found → "matched"
      │     resolveOrphansByTxHash(txHash)     ← marks any pending orphan as resolved
      │     PubSub.publish(BRIDGE_RECONCILIATION_UPDATE, { status: "matched", ... })
      │
      └── ONE side missing → "unmatched"
            upsertBridgeReconciliationOrphan({ orphanType, txHash, ... })
            PubSub.publish(BRIDGE_RECONCILIATION_UPDATE, { status: "unmatched", ... })
```

---

## MongoDB Collections

### `BridgeDepositLog`
**File:** `src/services/mongoose/schema.ts` (line ~661)  
**Repository:** `src/services/mongoose/bridge-deposit-log.ts`

Records every Bridge webhook event received. One document per `eventId` (unique).

| Field | Description |
|---|---|
| `eventId` | Unique Bridge webhook event ID (dedup key) |
| `transferId` | Bridge transfer ID |
| `customerId` | Bridge customer (maps to Flash account) |
| `state` | Transfer state — one of `awaiting_funds`, `funds_received`, `payment_submitted`, `payment_processed`. Reconciliation only reads `payment_processed` rows. |
| `amount` / `currency` | Transfer amount |
| `destinationTxHash` | On-chain tx hash — **the join key with IBEX** |
| `developerFee` / `subtotalAmount` / `initialAmount` / `finalAmount` | Fee breakdown |
| `createdAt` | When the webhook was received |

**Key indexes:** `transferId`, `customerId + createdAt`

---

### `IbexCryptoReceiveLog`
**File:** `src/services/mongoose/schema.ts` (line ~681)  
**Repository:** `src/services/mongoose/ibex-crypto-receive-log.ts`

Records every IBEX crypto.receive webhook. Upserted on `txHash` (idempotent).

| Field | Description |
|---|---|
| `txHash` | On-chain tx hash — **the join key with Bridge** |
| `address` | Ethereum/Tron address that received the USDT |
| `amount` / `currency` | Amount received |
| `network` | `tron` |
| `accountId` | Flash account ID looked up by address |
| `receivedAt` | Timestamp |

**Key indexes:** `receivedAt`, `address + receivedAt`

---

### `BridgeReconciliationOrphan`
**File:** `src/services/mongoose/schema.ts` (line ~699)  
**Repository:** `src/services/mongoose/bridge-reconciliation-orphan.ts`

Stores every detected mismatch. Upserted by `orphanKey` so duplicate detections are idempotent. Updated to `resolved` when the missing side later arrives.

| Field | Description |
|---|---|
| `orphanKey` | Unique key: `bridge:{txHash}` or `ibex:{txHash}` or `bridge-no-tx:{transferId}` |
| `orphanType` | `bridge_without_ibex` or `ibex_without_bridge` |
| `status` | `unmatched` (default) or `resolved` |
| `txHash` | On-chain tx hash (if known) |
| `transferId` | Bridge transfer ID (if applicable) |
| `customerId` | Bridge customer ID (if applicable) |
| `amount` / `currency` | From whichever side was found |
| `triageContext` | JSON blob with diagnostic info (reason, window, timestamps) |
| `detectedAt` | When the mismatch was first detected |
| `resolvedAt` | When both sides were eventually matched |

**Key indexes:** `orphanType + detectedAt`, `detectedAt`, `status + detectedAt`, `txHash`

---

## Core Reconciliation Logic

### `reconcileByTxHash({ txHash })`
**File:** `src/services/bridge/reconciliation.ts`

The real-time reconciliation function. Called from both webhook handlers.

```
Input: txHash (string)

1. Normalize to lowercase
2. Query BridgeDepositLog and IbexCryptoReceiveLog in parallel
3. If both found:
     - Call resolveOrphansByTxHash(txHash) to mark orphan as resolved
     - Publish { status: "matched", txHash, transferId, ... } to Redis PubSub
4. If only Bridge found (bridge_without_ibex):
     - upsertBridgeReconciliationOrphan({ orphanKey: "bridge:{txHash}", ... })
     - Publish { status: "unmatched", orphanType: "bridge_without_ibex", ... }
5. If only IBEX found (ibex_without_bridge):
     - upsertBridgeReconciliationOrphan({ orphanKey: "ibex:{txHash}", ... })
     - Publish { status: "unmatched", orphanType: "ibex_without_bridge", ... }

Output: ReconcileByTxHashResult | Error
```

### `reconcileBridgeAndIbexDeposits({ windowMs })`
**File:** `src/services/bridge/reconciliation.ts`

The batch reconciliation function. Scans a time window (default 24h) and compares all Bridge deposits against all IBEX receives within that window. Used by the cron job as a safety net.

```
Input: windowMs (default 24 hours)

1. Fetch all BridgeDepositLog where state=payment_processed within window
2. Fetch all IbexCryptoReceiveLog within window
3. Build hash maps by txHash
4. Cross-check both directions:
     - Bridge deposit with no matching IBEX receive → orphan (bridge_without_ibex)
     - Bridge deposit with no destinationTxHash → orphan (bridge-no-tx:{transferId})
     - IBEX receive with no matching Bridge deposit → orphan (ibex_without_bridge)
5. Upsert all orphans found

Output: { scannedBridge, scannedIbex, bridgeWithoutIbex, ibexWithoutBridge }
```

---

## Webhook Entry Points

### Bridge deposit webhook
**File:** `src/services/bridge/webhook-server/routes/deposit.ts`  
**Triggered by:** Bridge.xyz POST to `/webhooks/bridge`

```
1. Parse event_id, event_object from body
2. Lock on "bridge-deposit:{transferId}:{state}" (idempotency)
3. Log via createBridgeDepositLog()
4. If state === "payment_processed" && receipt.destination_tx_hash:
     → reconcileByTxHash({ txHash: receipt.destination_tx_hash })  [fire-and-forget]
5. Return 200
```

### IBEX crypto receive webhook
**File:** `src/services/ibex/webhook-server/routes/crypto-receive.ts`  
**Triggered by:** IBEX POST to `/webhooks/ibex/crypto/receive`

```
1. Validate payload (requires USDT, tron, tx_hash, address, amount)
2. Lock on tx_hash via LockService (idempotency)
3. Look up Flash account by Ethereum address
4. Log via createIbexCryptoReceiveLog()
5. reconcileByTxHash({ txHash: tx_hash })  [fire-and-forget]
6. Credit USDT wallet (balance update logic)
7. Return 200
```

---

## Repository Functions

### `src/services/mongoose/bridge-reconciliation-orphan.ts`

| Function | Description |
|---|---|
| `upsertBridgeReconciliationOrphan(data)` | Create or update an orphan record. Always sets `status: "unmatched"` and refreshes `detectedAt`. Idempotent on `orphanKey`. |
| `resolveOrphansByTxHash(txHash)` | Bulk-update all orphans matching a txHash to `status: "resolved"` + sets `resolvedAt`. Called when a late-arriving webhook completes the pair. |
| `findOrphans({ status?, orphanType?, limit? })` | Query orphans for the admin dashboard. Defaults to 50 most recent, sorted by `detectedAt desc`. |

### `src/services/mongoose/bridge-deposit-log.ts`

| Function | Description |
|---|---|
| `createBridgeDepositLog(data)` | Insert a new Bridge deposit event. Fails on duplicate `eventId`. |

### `src/services/mongoose/ibex-crypto-receive-log.ts`

| Function | Description |
|---|---|
| `createIbexCryptoReceiveLog(data)` | Upsert an IBEX receive event (idempotent on `txHash`). |
| `findIbexCryptoReceiveLogsSince({ since, until })` | Fetch all IBEX receives in a time range. Used by the batch reconciliation. |

---

## PubSub & Real-time Events

**Trigger constant:** `BRIDGE_RECONCILIATION_UPDATE`  
**File:** `src/domain/pubsub/index.ts`

Every call to `reconcileByTxHash` publishes an event to Redis PubSub. The payload shape:

```ts
{
  txHash: string           // normalized lowercase tx hash
  status: "matched" | "unmatched"
  orphanType?: "bridge_without_ibex" | "ibex_without_bridge"
  transferId?: string      // Bridge transfer ID (if known)
  customerId?: string      // Bridge customer ID (if known)
  amount?: string
  currency?: string
  detectedAt: Date
}
```

---

## GraphQL API

### Subscription — real-time dashboard feed
**File:** `src/graphql/public/root/subscription/bridge-reconciliation.ts`  
**Registered in:** `src/graphql/public/subscriptions.ts`  
**Auth required:** yes (authenticated account)

```graphql
subscription {
  bridgeReconciliation {
    errors { message }
    event {
      txHash
      status          # "matched" | "unmatched"
      orphanType      # "bridge_without_ibex" | "ibex_without_bridge" | null
      transferId
      customerId
      amount
      currency
      detectedAt
    }
  }
}
```

Delivered over WebSocket (`ws-server.ts`, port `WEBSOCKET_PORT`). Every deposit that passes through the system emits one event here — `matched` when both sides arrived, `unmatched` when one side is still pending.

### Query — current orphan state
**File:** `src/graphql/admin/root/query/bridge-reconciliation-orphans.ts`  
**Registered in:** `src/graphql/admin/queries.ts`  
**Auth required:** yes (admin API, port 4002)

```graphql
query {
  bridgeReconciliationOrphans(
    status: "unmatched"          # optional: "unmatched" | "resolved"
    orphanType: "bridge_without_ibex"  # optional filter
    limit: 50                    # default 50
  ) {
    id
    orphanKey
    orphanType
    status
    txHash
    transferId
    customerId
    amount
    currency
    detectedAt
    resolvedAt
    triageContext     # JSON string with diagnostic detail
  }
}
```

**GraphQL type file:** `src/graphql/admin/types/object/bridge-reconciliation-orphan.ts`

---

## Building the Dashboard

The dashboard has two concerns: **live feed** (what is happening right now) and **current state** (what is still broken). They map directly to the two API endpoints.

---

### Architecture overview

```
Admin dashboard (browser)
      │
      ├── WebSocket (graphql-ws)  →  ws://API_HOST:WS_PORT/graphql
      │     subscription bridgeReconciliation { ... }
      │     Receives one event per deposit as it reconciles
      │
      └── HTTP (GraphQL)          →  http://ADMIN_HOST:4002/graphql
            query bridgeReconciliationOrphans { ... }
            Initial page load + periodic refresh of the unmatched table
```

Authentication for both:
- **WebSocket subscription** — uses the same JWT/Kratos cookie as the public API. The user must be authenticated (level 2 account). Pass the token in the `connectionParams` of the `graphql-ws` handshake.
- **Admin query** — uses the admin API token (`Authorization: Bearer <admin_token>`).

---

### Step 1 — Load initial state on page open

Call the admin query to populate the "currently unmatched" table before the WebSocket is even connected.

```graphql
# HTTP POST to http://ADMIN_HOST:4002/graphql
query ReconciliationSnapshot {
  bridgeReconciliationOrphans(status: "unmatched", limit: 100) {
    id
    orphanType
    txHash
    transferId
    customerId
    amount
    currency
    detectedAt
    triageContext
  }
}
```

This gives you the current backlog. Store it in a local map keyed by `txHash` — you will update this map as subscription events arrive.

---

### Step 2 — Open the WebSocket subscription

The subscription fires for every deposit that passes through the system — both healthy ones and mismatches.

```graphql
# WebSocket to ws://API_HOST:WS_PORT/graphql
subscription LiveReconciliation {
  bridgeReconciliation {
    errors { message }
    event {
      txHash
      status       # "matched" | "unmatched"
      orphanType   # "bridge_without_ibex" | "ibex_without_bridge" | null
      transferId
      customerId
      amount
      currency
      detectedAt
    }
  }
}
```

**On each event received:**

| `status` | What happened | Dashboard action |
|---|---|---|
| `matched` | Both sides arrived, all good | Remove `txHash` from the unmatched table (if present). Add a green row to the live feed. |
| `unmatched` | Only one side has arrived yet | Add/update `txHash` in the unmatched table. Add a red/orange row to the live feed. |

A `matched` event after an `unmatched` event for the same `txHash` means the late webhook finally arrived — remove the row from the unmatched table and mark it green in the live feed.

---

### Step 3 — Minimal React/JS implementation

```tsx
// hooks/useReconciliation.ts
import { createClient } from "graphql-ws"
import { useEffect, useState } from "react"

type ReconciliationEvent = {
  txHash: string
  status: "matched" | "unmatched"
  orphanType?: string
  transferId?: string
  customerId?: string
  amount?: string
  currency?: string
  detectedAt: string
}

type OrphanRow = ReconciliationEvent & { since: string }

export function useReconciliation(authToken: string) {
  const [liveEvents, setLiveEvents] = useState<ReconciliationEvent[]>([])
  const [unmatchedMap, setUnmatchedMap] = useState<Map<string, OrphanRow>>(new Map())

  // ── Initial snapshot ──────────────────────────────────────────────────────
  useEffect(() => {
    fetch("http://ADMIN_HOST:4002/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        query: `query {
          bridgeReconciliationOrphans(status: "unmatched", limit: 100) {
            txHash orphanType transferId customerId amount currency detectedAt triageContext
          }
        }`,
      }),
    })
      .then((r) => r.json())
      .then((json) => {
        const rows: OrphanRow[] = json.data?.bridgeReconciliationOrphans ?? []
        setUnmatchedMap(new Map(rows.map((r) => [r.txHash, { ...r, since: r.detectedAt }])))
      })
  }, [authToken])

  // ── Live subscription ─────────────────────────────────────────────────────
  useEffect(() => {
    const client = createClient({
      url: "ws://API_HOST:WS_PORT/graphql",
      connectionParams: { Authorization: `Bearer ${authToken}` },
    })

    const unsubscribe = client.subscribe(
      {
        query: `subscription {
          bridgeReconciliation {
            event {
              txHash status orphanType transferId customerId amount currency detectedAt
            }
          }
        }`,
      },
      {
        next({ data }) {
          const event: ReconciliationEvent = data?.bridgeReconciliation?.event
          if (!event) return

          // Prepend to live feed (cap at 200 rows)
          setLiveEvents((prev) => [event, ...prev].slice(0, 200))

          // Update unmatched table
          setUnmatchedMap((prev) => {
            const next = new Map(prev)
            if (event.status === "matched") {
              next.delete(event.txHash)
            } else {
              next.set(event.txHash, { ...event, since: event.detectedAt })
            }
            return next
          })
        },
        error(err) {
          console.error("Reconciliation subscription error", err)
        },
        complete() {},
      },
    )

    return () => unsubscribe()
  }, [authToken])

  return {
    liveEvents,
    unmatchedOrphans: Array.from(unmatchedMap.values()),
  }
}
```

Install the WebSocket client:
```bash
yarn add graphql-ws
```

---

### Step 4 — What to display

**Panel 1: Live feed** (scrolling table, newest first)

| Time | Status | Amount | txHash | Type |
|---|---|---|---|---|
| 14:03:22 | ✅ matched | 250 USDT | 0xabc… | — |
| 14:03:19 | ⚠️ unmatched | 100 USDT | 0xdef… | bridge_without_ibex |
| 14:03:19 | ✅ matched | 500 USDT | 0x123… | — |

- Green row (`matched`) = healthy deposit, both sides confirmed.
- Orange row (`unmatched`) = one side pending. Will turn green if the other side arrives within seconds.
- Red row (`unmatched` that stays > ~30 seconds) = likely a real problem requiring investigation.

**Panel 2: Unmatched orphans table** (current state, sourced from snapshot + subscription deltas)

| Since | Type | Amount | txHash | Customer | Triage |
|---|---|---|---|---|---|
| 14:01:05 | bridge_without_ibex | 100 USDT | 0xdef… | cus_xyz | reason: "No IBEX..." |

This table shrinks as matched events arrive. If a row persists for more than a few minutes it needs human triage. The `triageContext` JSON field has the diagnostic detail.

**Panel 3: Counters** (derived from the above)

```
Matched (last hour):   47    Unmatched (open):   2    Avg resolution: 2.3s
```

---

### Step 5 — Interpreting orphan types

| `orphanType` | Most likely cause | Triage action |
|---|---|---|
| `bridge_without_ibex` | IBEX webhook is delayed or lost | Check IBEX webhook delivery logs. If txHash exists on-chain but no IBEX receive: replay the IBEX webhook manually. |
| `ibex_without_bridge` | Bridge webhook is delayed or lost; or IBEX received funds that Bridge did not route through us | Check Bridge webhook delivery logs. If this is an unknown tx, flag for security review. |

Both types automatically self-resolve in the dashboard the moment the late webhook arrives — no page refresh needed.

---

### Step 6 — Alerting

For orphans that don't self-resolve within a threshold (e.g. 5 minutes), hook into the subscription on the server side or poll the admin query on a schedule:

```ts
// Server-side alert: poll for orphans older than 5 minutes
const staleOrphans = await findOrphans({ status: "unmatched", limit: 100 })
const fiveMinutesAgo = Date.now() - 5 * 60 * 1000
const stale = staleOrphans.filter(
  (o) => o.detectedAt.getTime() < fiveMinutesAgo
)
if (stale.length > 0) {
  // send Slack/PagerDuty alert
}
```

This check can live in its own lightweight cron task or be added to the existing `reconcileBridgeDepositsJob` in `src/servers/cron.ts`.

---

## Cron Job (batch safety net)

**File:** `src/servers/cron.ts`

The function `reconcileBridgeDepositsJob` calls `reconcileBridgeAndIbexDeposits()` on every cron run. It is gated on `BridgeConfig.enabled`. The cron process runs all tasks sequentially on a schedule defined in config.

With real-time reconciliation in place, the batch job now serves as a **catch-all** for edge cases:
- Webhooks that arrived out of order with a long delay
- Events processed during a server restart gap
- Any bug in the real-time path that caused a mismatch to be missed

The window is now **15 minutes** — matching the expected maximum delay for a webhook retry. If the cron is scheduled less frequently than every 15 minutes, increase `RECONCILE_WINDOW_MS` in `cron.ts` to match the cron interval so there are no blind spots between runs.

---

## Orphan Key Convention

| Pattern | Meaning |
|---|---|
| `bridge:{txHash}` | Bridge reached `payment_processed` with this txHash, but IBEX has not confirmed yet |
| `ibex:{txHash}` | IBEX saw a crypto.receive with this txHash, but no Bridge `payment_processed` found |
| `bridge-no-tx:{transferId}` | Bridge `payment_processed` event has no `destinationTxHash` at all (used by batch only) |

All keys are lowercase-normalized to prevent case-mismatch duplicates.

---

## Deep Code-Level Walkthrough

This section traces every reconciliation path from the first line of code that runs to the last, explaining what each piece does and why it is written that way.

---

### Part 1 — How a Bridge webhook triggers reconciliation

**File:** `src/services/bridge/webhook-server/routes/deposit.ts`

Bridge.xyz calls this endpoint every time a transfer changes state. The first two lines extract the payload:

```ts
const { event_id, event_object } = req.body
const { id, state, amount, currency, on_behalf_of, receipt } = event_object ?? {}
```

`event_id` is Bridge's unique identifier for this specific webhook delivery — it is the dedup key. `event_object` contains the transfer itself. `receipt` is the sub-object that carries fee breakdown and, crucially, `destination_tx_hash` — the on-chain hash of the USDT transaction that Bridge sent to the IBEX address.

Next, before doing any work, the handler acquires a lock:

```ts
const lockKey = `bridge-deposit:${id}:${state}`
const lockResult = await LockService().lockIdempotencyKey(lockKey as IdempotencyKey)
if (lockResult instanceof Error) {
  return res.status(200).json({ status: "already_processed" })
}
```

The lock key is `bridge-deposit:{transferId}:{state}`. It includes both the transfer ID **and** the state because Bridge sends one webhook per state transition — the same transfer ID will appear multiple times (`payment_submitted`, `funds_received`, etc.). Without the state in the key, a second state transition would be rejected as a duplicate. The lock is backed by Redis and is idempotent: if the same key is acquired twice, the second call returns an error and the handler returns `200` immediately without reprocessing.

After logging and persisting the event:

```ts
const depositLog = await createBridgeDepositLog({ ... })
```

This calls `BridgeDepositLog.create(data)` in `bridge-deposit-log.ts`. It inserts a new document. The `eventId` field has a `unique: true` index in the schema (`schema.ts` line 662), so a second call with the same `eventId` would throw a duplicate key error — a second layer of idempotency on top of the Redis lock.

Then reconciliation is triggered:

```ts
if (state === "payment_processed" && receipt?.destination_tx_hash) {
  reconcileByTxHash({ txHash: receipt.destination_tx_hash }).catch((err) =>
    baseLogger.error({ err, event_id, id }, "Real-time reconciliation failed"),
  )
}
```

Three things to notice:

1. **The `state === "payment_processed"` guard.** Bridge fires one webhook per state transition: `awaiting_funds` → `funds_received` → `payment_submitted` → `payment_processed`. Only `payment_processed` means the USDT has been fully delivered on-chain and the `destinationTxHash` is present. Triggering on any earlier state would always produce a false `bridge_without_ibex` orphan because the on-chain transaction does not exist yet.

2. **The `receipt?.destination_tx_hash` guard.** Even at `payment_processed`, Bridge could theoretically omit the hash in an edge case. If it is absent, reconciliation cannot match anything so there is no point calling it — the batch pass will catch it via the `bridge-no-tx:{transferId}` orphan key.

3. **Fire-and-forget with `.catch()`.** `reconcileByTxHash` is called without `await`. This means the webhook response (`200 success`) is sent to Bridge **immediately** without waiting for reconciliation to finish. This is intentional: Bridge's webhook delivery has a timeout, and reconciliation involves two database queries plus a Redis publish. Letting those run in the background keeps the webhook handler fast and prevents Bridge from marking the delivery as failed and retrying. The `.catch()` ensures any thrown error is logged and not silently swallowed.

---

### Part 2 — How an IBEX webhook triggers reconciliation

**File:** `src/services/ibex/webhook-server/routes/crypto-receive.ts`

IBEX calls this endpoint when it detects a USDT receive on the Tron/Ethereum address it manages. The key difference from the Bridge handler is the idempotency mechanism:

```ts
const lockResult = await LockService().lockPaymentHash(
  tx_hash as PaymentHash,
  async () => { ... }
)
```

Unlike the Bridge handler which locks and then returns, `lockPaymentHash` locks **and runs the entire callback inside the lock**. The callback returns a `CryptoReceiveResult` object. If the lock is already held (duplicate webhook), the outer lock call returns an `Error` and the handler returns `200 already_processed` without executing the callback at all.

Inside the callback, after finding the account and persisting the log:

```ts
const ibexLog = await createIbexCryptoReceiveLog({
  txHash: String(tx_hash),
  ...
})
```

In `ibex-crypto-receive-log.ts`, this uses `findOneAndUpdate` with `upsert: true`:

```ts
const log = await IbexCryptoReceiveLog.findOneAndUpdate(
  { txHash: data.txHash },
  { ...data, receivedAt: new Date() },
  { upsert: true, new: true, setDefaultsOnInsert: true },
)
```

This is an upsert rather than an insert. If the document already exists (same `txHash`), it updates it in place instead of throwing a duplicate error. This handles the case where IBEX retries a webhook after a timeout — the second call is safe and idempotent.

Immediately after logging:

```ts
reconcileByTxHash({ txHash: String(tx_hash) }).catch((err) =>
  baseLogger.error({ err, tx_hash }, "Real-time reconciliation failed"),
)
```

Same fire-and-forget pattern as the Bridge handler. The wallet credit logic that follows continues on the same execution path without waiting for reconciliation. If reconciliation fails for any reason, it does not roll back the wallet credit — they are independent operations.

---

### Part 3 — Inside `reconcileByTxHash`

**File:** `src/services/bridge/reconciliation.ts`, lines 173–280

This is the core of the real-time system. The first thing it does is normalize the hash:

```ts
const normalizedHash = txHash.toLowerCase()
```

USDT transaction hashes can be delivered in mixed case depending on the system that generates them. Bridge might send `0xABC123` and IBEX might send `0xabc123`. Without normalization, these would never match. All storage and comparison happens in lowercase throughout the system.

Next, both sides are queried simultaneously:

```ts
const [bridgeDeposit, ibexReceive] = await Promise.all([
  BridgeDepositLog.findOne({
    destinationTxHash: { $regex: new RegExp(`^${normalizedHash}$`, "i") },
    state: "payment_processed",
  }).lean().exec(),
  IbexCryptoReceiveLog.findOne({
    txHash: { $regex: new RegExp(`^${normalizedHash}$`, "i") },
  }).lean().exec(),
])
```

`Promise.all` runs both MongoDB queries in parallel — they go to the database at the same time and the code waits for both to complete before continuing. This is faster than two sequential awaits.

The `$regex` with case-insensitive flag (`"i"`) is a defensive second layer of normalization on top of the `.toLowerCase()`. Even if a document was stored with unexpected casing, the query will still find it.

`.lean()` tells Mongoose to return a plain JavaScript object instead of a full Mongoose document instance. This skips building the Mongoose model wrapper, making the query faster and using less memory. It is the right choice here because we only need to read fields — we are not calling `.save()` or any other model methods on the result.

The `state: "payment_processed"` filter on the Bridge query is critical: it prevents earlier states (`funds_received`, `payment_submitted`) for the same transfer from being treated as a match. Only `payment_processed` — the final state where the USDT has been delivered on-chain — counts.

**Branch 1 — Both found (matched):**

```ts
if (bridgeDeposit && ibexReceive) {
  await resolveOrphansByTxHash(normalizedHash)
  const event = { txHash: normalizedHash, status: "matched", ... }
  pubsub.publish({ trigger: PubSubDefaultTriggers.BridgeReconciliationUpdate, payload: event })
  return event
}
```

`resolveOrphansByTxHash` is called first with `await` — unlike the reconciliation call from webhooks, this resolution is awaited because it needs to happen before publishing. If it were not awaited, the dashboard could receive a `matched` event and then still see the orphan as `unmatched` in the database for a brief window. See Part 5 for the internals of `resolveOrphansByTxHash`.

**Branch 2 — Only Bridge found:**

```ts
if (bridgeDeposit && !ibexReceive) {
  orphanType = "bridge_without_ibex"
  orphanKey = toOrphanKey("bridge", normalizedHash)  // → "bridge:0xabc..."
  transferId = bridgeDeposit.transferId
  ...
  triageContext = {
    reason: "Bridge payment_processed has no matching IBEX crypto.receive yet",
    txHash: normalizedHash,
    depositState: bridgeDeposit.state,
    createdAt: bridgeDeposit.createdAt.toISOString(),
    detectedAt: now.toISOString(),
  }
}
```

The `toOrphanKey` helper (`const toOrphanKey = (prefix, value) => \`${prefix}:${value.toLowerCase()}\``) creates a deterministic string from the prefix and the hash. The prefix distinguishes the three possible orphan scenarios (`bridge:`, `ibex:`, `bridge-no-tx:`). The same hash from the same direction will always produce the same key — this is what makes `upsertBridgeReconciliationOrphan` idempotent.

**Branch 3 — Only IBEX found (else branch):**

```ts
} else {
  orphanType = "ibex_without_bridge"
  orphanKey = toOrphanKey("ibex", normalizedHash)  // → "ibex:0xabc..."
  ...
}
```

The `else` here catches two cases: only IBEX found, and neither found. The "neither found" case cannot happen in normal operation because `reconcileByTxHash` is always called right after one side has been logged. However, if it did happen (e.g. a database rollback), the code would produce an `ibex_without_bridge` orphan with `undefined` fields — which is safe, just slightly misleading. The `triageContext.reason` would still identify the situation.

After the branch, regardless of direction:

```ts
await upsertBridgeReconciliationOrphan({
  orphanKey, orphanType, txHash: normalizedHash, ...
})
pubsub.publish({ trigger: PubSubDefaultTriggers.BridgeReconciliationUpdate, payload: event })
```

The upsert is awaited here so that the orphan is guaranteed to be in the database before the PubSub event is published. This prevents a race condition where a dashboard queries the orphan by ID immediately after receiving the event and finds nothing.

---

### Part 4 — Inside `upsertBridgeReconciliationOrphan`

**File:** `src/services/mongoose/bridge-reconciliation-orphan.ts`, lines 6–28

```ts
const orphan = await BridgeReconciliationOrphan.findOneAndUpdate(
  { orphanKey: data.orphanKey },         // ← find by this key
  { ...data, status: "unmatched", detectedAt: new Date() },  // ← write this
  { upsert: true, new: true, setDefaultsOnInsert: true },
)
```

`findOneAndUpdate` with `upsert: true` is a single atomic MongoDB operation. It either:
- Finds a document with matching `orphanKey` and updates it, or
- Creates a new document if none exists.

This means calling it twice with the same `orphanKey` is completely safe — the second call simply refreshes `detectedAt` and overwrites the data. It does not create duplicates. The `orphanKey` field has a `unique: true` index in the schema, which enforces this at the database level as well.

`new: true` means the operation returns the document **after** the update (the new version), not the old one. This is relevant if the caller needs to read back the written state.

`status: "unmatched"` is always hard-coded here. Even if a resolved orphan somehow gets updated through this function again (which should not happen in normal flow), it gets reset to `unmatched`. This is intentional: if a txHash appears as an orphan again after being resolved, something unexpected happened and it should be flagged as needing attention.

---

### Part 5 — Inside `resolveOrphansByTxHash`

**File:** `src/services/mongoose/bridge-reconciliation-orphan.ts`, lines 30–46

```ts
const result = await BridgeReconciliationOrphan.updateMany(
  {
    txHash: txHash.toLowerCase(),
    status: "unmatched",
  },
  { $set: { status: "resolved", resolvedAt: now } },
)
return { resolvedCount: result.modifiedCount }
```

`updateMany` instead of `findOneAndUpdate` because there can theoretically be two orphan documents for the same txHash — one `bridge:` key and one `ibex:` key. For example:

- Bridge webhook arrives first → `bridge:0xabc` orphan created
- IBEX webhook arrives, before reconciliation fires → `ibex:0xabc` could exist in an edge case
- When both are now present, both orphan records should be resolved

The `status: "unmatched"` filter ensures that already-resolved orphans are not touched again (no re-setting `resolvedAt` to a later timestamp).

`result.modifiedCount` tells us how many documents were actually updated. This is logged and returned so callers can see whether any orphans were actually cleaned up or whether this was a match that never had an orphan (normal case when both webhooks arrive within milliseconds of each other).

---

### Part 6 — The PubSub chain from publish to dashboard

**Publish side** (`src/services/bridge/reconciliation.ts`):

```ts
pubsub.publish({ trigger: PubSubDefaultTriggers.BridgeReconciliationUpdate, payload: event })
```

`PubSubDefaultTriggers.BridgeReconciliationUpdate` resolves to the string `"BRIDGE_RECONCILIATION_UPDATE"` (defined in `src/domain/pubsub/index.ts`). This string is the Redis channel name.

`PubSubService().publish` (in `src/services/pubsub.ts`) calls:

```ts
return await redisPubSub.publish(trigger, payload)
```

`redisPubSub` is a `graphql-redis-subscriptions` instance that wraps a Redis client. The `publish` call serializes `payload` to JSON and calls `PUBLISH BRIDGE_RECONCILIATION_UPDATE <json>` on Redis. Any Redis subscriber listening to that channel receives the message immediately.

**Subscribe side** (`src/graphql/public/root/subscription/bridge-reconciliation.ts`):

When a client opens the subscription, GraphQL calls the `subscribe` method:

```ts
subscribe: (_source, _args, ctx) => {
  if (!ctx.domainAccount) throw new AuthenticationError(...)
  return pubsub.createAsyncIterator({
    trigger: PubSubDefaultTriggers.BridgeReconciliationUpdate,
  })
}
```

`createAsyncIterator` calls `redisPubSub.asyncIterator("BRIDGE_RECONCILIATION_UPDATE")`. This registers a Redis `SUBSCRIBE` command on that channel and returns an async iterator. Every time Redis receives a `PUBLISH` on that channel, the iterator yields the deserialized payload object.

When the iterator yields a value, GraphQL calls the `resolve` method with that value as `rawSource`:

```ts
resolve: (rawSource: unknown) => {
  const source = rawSource as ReconciliationEventPayload | undefined
  return {
    errors: [],
    event: {
      txHash: source.txHash,
      status: source.status,
      detectedAt: source.detectedAt instanceof Date
        ? source.detectedAt.toISOString()
        : String(source.detectedAt),
      ...
    },
  }
}
```

The `detectedAt` handling (`instanceof Date` check) is because the object passed through Redis loses its `Date` type — JSON serialization converts `Date` to an ISO string. So on the receiving end it arrives as a string, not a `Date`. The resolver handles both cases defensively.

The resolved object is sent to the WebSocket client as a GraphQL `data` message. The client's `graphql-ws` library deserializes it and fires the `next` callback in the subscription.

---

### Part 7 — The batch path (`reconcileBridgeAndIbexDeposits`)

**File:** `src/services/bridge/reconciliation.ts`, lines 36–160

This runs inside the cron job (`src/servers/cron.ts`) with a 15-minute window.

**Step 1 — Fetch both sides in the window:**

```ts
const now = new Date()
const since = new Date(now.getTime() - windowMs)

const bridgeDeposits = await BridgeDepositLog.find({
  createdAt: { $gte: since, $lte: now },
  state: "payment_processed",
}).lean().exec()

const ibexReceivesResult = await findIbexCryptoReceiveLogsSince({ since, until: now })
```

These two queries are sequential (not `Promise.all`) — a deliberate choice. The batch job is not latency-sensitive, and running them in parallel would consume two MongoDB connections simultaneously, adding pressure on the connection pool.

`findIbexCryptoReceiveLogsSince` queries by `receivedAt` (the timestamp when the IBEX webhook was processed), not by some external timestamp from IBEX. This is important: it uses the time the record was written to the database, which is stable and predictable, rather than any time reported by an external system.

**Step 2 — Build lookup maps:**

```ts
const ibexByTxHash = new Map<string, IbexReceiveLike>()
for (const record of ibexReceives) {
  ibexByTxHash.set(record.txHash.toLowerCase(), record)
}

const bridgeByTxHash = new Map<string, BridgeDepositLike>()
for (const deposit of bridgeDeposits) {
  if (!deposit.destinationTxHash) continue
  bridgeByTxHash.set(deposit.destinationTxHash.toLowerCase(), deposit)
}
```

Both sides are indexed into `Map` objects before any cross-checking happens. This converts the cross-check from O(n × m) (for each Bridge deposit, scan all IBEX receives) to O(n + m) (build two maps, then do O(1) lookups). For 1000 Bridge deposits and 1000 IBEX receives, this is the difference between 1,000,000 comparisons and 2,000 operations.

**Step 3 — Bridge → IBEX check:**

```ts
for (const deposit of bridgeDeposits) {
  if (!deposit.destinationTxHash) {
    // Special case: Bridge reached payment_processed but never included a tx hash
    bridgeWithoutIbex++
    await upsertBridgeReconciliationOrphan({
      orphanKey: toOrphanKey("bridge-no-tx", deposit.transferId),
      orphanType: "bridge_without_ibex",
      ...
    })
    continue
  }

  const matchedIbex = ibexByTxHash.get(deposit.destinationTxHash.toLowerCase())
  if (matchedIbex) continue  // ← matched, nothing to do

  // No matching IBEX receive found
  bridgeWithoutIbex++
  await upsertBridgeReconciliationOrphan(...)
}
```

The `bridge-no-tx:{transferId}` key is unique to the batch path. The real-time path never creates this type because `reconcileByTxHash` requires a txHash to operate — it is only called when `receipt.destination_tx_hash` is present. The batch finds these cases by scanning all `payment_processed` deposits regardless of whether they have a txHash.

Each `upsertBridgeReconciliationOrphan` is awaited individually inside the loop. This is sequential — one upsert at a time. The batch job is not performance-critical (it runs once every cron cycle, not per-request), and sequential writes are simpler and safer than batching.

**Step 4 — IBEX → Bridge check:**

```ts
for (const receive of ibexReceives) {
  const matchedBridge = bridgeByTxHash.get(receive.txHash.toLowerCase())
  if (matchedBridge) continue

  ibexWithoutBridge++
  await upsertBridgeReconciliationOrphan({
    orphanKey: toOrphanKey("ibex", receive.txHash),
    orphanType: "ibex_without_bridge",
    ...
  })
}
```

This is the reverse direction: for each IBEX receive, check whether a Bridge deposit with that txHash exists. A deposit missing from this direction means IBEX received USDT that Bridge did not route through us — potentially a user sending USDT directly to their IBEX address without going through Bridge.

**Note:** The batch path does **not** call `resolveOrphansByTxHash`. It only creates orphans, never resolves them. Resolution is the exclusive job of `reconcileByTxHash` (real-time path), which is triggered on every webhook. The batch's job is to catch things the real-time path missed, not to retroactively match things.

---

### Part 8 — The admin query path

**File:** `src/graphql/admin/root/query/bridge-reconciliation-orphans.ts`

```ts
resolve: async (_, { status, orphanType, limit }) => {
  const result = await findOrphans({ status, orphanType, limit })
  if (result instanceof Error) throw result

  return result.map((o) => ({
    ...o,
    detectedAt: o.detectedAt.toISOString(),
    resolvedAt: o.resolvedAt?.toISOString() ?? null,
    triageContext: JSON.stringify(o.triageContext),
  }))
}
```

`triageContext` is stored in MongoDB as a free-form `Mixed` type (plain object). GraphQL has no native JSON scalar in this schema, so it is serialized to a JSON string before being sent. The dashboard client must `JSON.parse` it to access the individual fields.

`resolvedAt` uses optional chaining (`?.`) because it is absent on all `unmatched` orphans — only `resolved` orphans have it set. Without `?? null`, it would be `undefined`, which GraphQL treats as a missing field. The explicit `null` tells the client the field exists but has no value yet.

`findOrphans` in `bridge-reconciliation-orphan.ts` builds the MongoDB filter dynamically:

```ts
const filter: Record<string, unknown> = {}
if (status) filter.status = status
if (orphanType) filter.orphanType = orphanType
```

If neither argument is provided, `filter` is `{}` — which matches all documents. The query then sorts by `detectedAt: -1` (newest first) and applies the limit. The `{ status: 1, detectedAt: -1 }` compound index in the schema means a query for `status: "unmatched"` with a sort on `detectedAt` is served entirely from the index without scanning documents.

---

### Part 9 — CLI script path

**File:** `src/scripts/reconcile-bridge-ibex-deposits.ts`

```ts
const windowMs = Math.max(1, Math.floor(args["window-hours"])) * 60 * 60 * 1000
```

`Math.floor` converts fractional hours to a whole number before multiplying. `Math.max(1, ...)` ensures the minimum window is 1 hour even if `0` is passed — preventing an accidentally empty scan. The `default: 0.25` (15 minutes) makes the CLI consistent with the cron default.

The script connects to MongoDB, runs the batch function, then explicitly closes the connection and exits:

```ts
setupMongoConnection()
  .then(async (mongoose) => {
    await main()
    await mongoose?.connection.close()
    process.exit(0)
  })
```

`process.exit(0)` is necessary because Node.js would otherwise keep running while the MongoDB connection pool is open. The `process.exit(1)` in the `.catch()` branch signals failure to the calling process (the shell or CI system), which can then alert on a non-zero exit code.

---

## Self-healing: Late Webhook Resolves the Orphan

A common scenario is that both webhooks arrive within seconds of each other but one lands first:

```
T+0s   Bridge webhook arrives → reconcileByTxHash()
         → IBEX not yet logged → orphan created (bridge_without_ibex, status: unmatched)
         → PubSub event: { status: "unmatched" }

T+3s   IBEX webhook arrives → reconcileByTxHash()
         → Both sides now in DB → resolveOrphansByTxHash()
         → Orphan updated: status: "resolved", resolvedAt: T+3s
         → PubSub event: { status: "matched" }
```

The dashboard subscription will show `unmatched` briefly and then automatically update to `matched` — no manual intervention needed for normal deposits.

---

## Testing the Reconciliation System

Three levels of coverage — run them in order.

---

### Level 1: Unit Tests

Run the reconciliation unit tests (mocks all external services, no Docker needed):

```bash
yarn test:unit --testPathPattern="reconciliation"
```

To also include the deposit and replay CLI tests:

```bash
yarn test:unit --testPathPattern="reconciliation|deposit|replay"
```

| Test file | What it covers |
|---|---|
| `test/flash/unit/services/bridge/reconciliation.spec.ts` | `reconcileByTxHash` (matched/unmatched/self-healing/normalization) + `reconcileBridgeAndIbexDeposits` (all orphan types, error path) |
| `test/flash/unit/services/bridge/webhook-server/routes/deposit.spec.ts` | Bridge deposit webhook handler (idempotency, log creation, reconciliation trigger) |
| `test/flash/unit/scripts/replay-bridge-webhook.spec.ts` | Replay CLI (dry-run, live, error handling) |

All three test files together: **57 tests, all passing**.

---

### Level 2: Manual E2E with curl

Fires real webhooks against a running local dev stack and verifies MongoDB state.

#### 2.1 Start dependencies

```bash
make start-deps
```

This starts MongoDB, Redis, and other backing services via Docker Compose.

#### 2.2 Start the webhook servers

In two separate terminals:

```bash
# Bridge webhook server (port 4009)
yarn bridge-webhook

# IBEX webhook server (port 4008)
make start-ibex-wh
```

#### 2.3 Fire the Bridge `payment_processed` webhook

```bash
curl -s -X POST http://localhost:4009/webhooks/deposit \
  -H "Content-Type: application/json" \
  -H "Bridge-Signature: $(echo -n '{"event_id":"evt_test_001","event_object":{"id":"tr_test_001","state":"payment_processed","amount":"100","currency":"usdt","on_behalf_of":"cust_test_001","receipt":{"initial_amount":"100","subtotal_amount":"99.5","final_amount":"99","developer_fee":"0.5","destination_tx_hash":"0xabc123def456"}}}' | openssl dgst -sha256 -hmac "not-so-secret" -binary | xxd -p -c 256)" \
  -d '{
    "event_id": "evt_test_001",
    "event_object": {
      "id": "tr_test_001",
      "state": "payment_processed",
      "amount": "100",
      "currency": "usdt",
      "on_behalf_of": "cust_test_001",
      "receipt": {
        "initial_amount": "100",
        "subtotal_amount": "99.5",
        "final_amount": "99",
        "developer_fee": "0.5",
        "destination_tx_hash": "0xabc123def456"
      }
    }
  }'
```

Expected response: `{"status":"success"}`

Check MongoDB — a `BridgeReconciliationOrphan` with `orphanType: "bridge_without_ibex"` and `status: "unmatched"` should appear because IBEX hasn't fired yet:

```js
// In mongosh
db.bridgereconciliationorphans.findOne({ txHash: "0xabc123def456" })
// → { orphanKey: "bridge:0xabc123def456", orphanType: "bridge_without_ibex", status: "unmatched", ... }
```

#### 2.4 Fire the IBEX `crypto.receive` webhook

```bash
curl -s -X POST http://localhost:4008/webhooks/ibex \
  -H "Content-Type: application/json" \
  -H "x-ibex-signature: $(echo -n '{"event":"crypto.receive","data":{"tx_hash":"0xabc123def456","address":"0xdeadbeef","amount":"99","currency":"USDT","network":"tron","account_id":"acc_test_001"}}' | openssl dgst -sha256 -hmac "also-not-so-secret" -binary | xxd -p -c 256)" \
  -d '{
    "event": "crypto.receive",
    "data": {
      "tx_hash": "0xabc123def456",
      "address": "0xdeadbeef",
      "amount": "99",
      "currency": "USDT",
      "network": "tron",
      "account_id": "acc_test_001"
    }
  }'
```

Expected response: `{"status":"success"}`

Now verify the orphan was resolved:

```js
db.bridgereconciliationorphans.findOne({ txHash: "0xabc123def456" })
// → { status: "resolved", resolvedAt: ISODate("..."), ... }
```

#### 2.5 Check the admin GraphQL query

Start the admin server (port 4002):

```bash
yarn start-admin   # or: yarn dev in the main app
```

Query all unmatched orphans:

```graphql
query {
  bridgeReconciliationOrphans(status: "unmatched", limit: 10) {
    orphanKey
    orphanType
    txHash
    transferId
    customerId
    amount
    currency
    status
    detectedAt
    resolvedAt
    triageContext
  }
}
```

Send via curl:

```bash
curl -s -X POST http://localhost:4002/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <admin-token>" \
  -d '{"query":"{ bridgeReconciliationOrphans(status: \"unmatched\", limit: 10) { orphanKey orphanType txHash status detectedAt triageContext } }"}'
```

#### 2.6 Run the batch reconciliation script manually

```bash
yarn ts-node -r tsconfig-paths/register \
  src/scripts/reconcile-bridge-ibex-deposits.ts \
  --configPath=<path-to-config> \
  --window-hours=0.25
```

Expected output: `{ scannedBridge: N, scannedIbex: N, bridgeWithoutIbex: 0, ibexWithoutBridge: 0 }`

If you ran both webhooks above, the batch should find everything already matched.

#### 2.7 Test the replay CLI

Replay the Bridge event from MongoDB:

```bash
yarn ts-node -r tsconfig-paths/register \
  src/scripts/replay-bridge-webhook.ts \
  --eventId evt_test_001 \
  --configPath=<path-to-config>
```

Add `--dry-run` to preview without firing:

```bash
yarn ts-node -r tsconfig-paths/register \
  src/scripts/replay-bridge-webhook.ts \
  --eventId evt_test_001 \
  --dry-run \
  --configPath=<path-to-config>
```

Expected dry-run output shows the payload that would be sent without hitting the webhook server.

---

### Level 3: Automated Integration Tests

Runs the full stack with a real MongoDB and Redis:

```bash
make start-deps-integration
yarn test:integration
```

The integration suite covers the deposit webhook handler end-to-end, including the reconciliation side-effect.

---

### Quick Reference: Ports and Secrets

| Service | Port | HMAC secret env var | Default dev secret |
|---|---|---|---|
| Bridge webhook server | 4009 | `BRIDGE_WEBHOOK_SECRET` | `not-so-secret` |
| IBEX webhook server | 4008 | `IBEX_WEBHOOK_SECRET` | `also-not-so-secret` |
| Admin GraphQL | 4002 | — | — |
| Public GraphQL + WS | `PORT` / `WEBSOCKET_PORT` | — | — |
