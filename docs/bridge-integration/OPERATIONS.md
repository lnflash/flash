# Bridge.xyz Integration — Operations Runbook

> v0 of the **ENG-272** runbook. Written against
> `docs/bridge-integration-spec @ 85af420`. Anything marked **TBD** depends
> on deployment manifests that live outside this repo (charts repo / infra
> repo); fill in once those are linked.

## 1. System map (one screen)

```text
                   ┌──────────────────────────┐
   GraphQL (TLS) ──┤ API server               │
                   │  src/graphql/public/...  │
                   └──────────┬───────────────┘
                              │ BridgeService
                              ▼
                   ┌──────────────────────────┐
                   │ services.bridge          │
                   │  client.ts ──► api.bridge.xyz/v0  (Api-Key header)
                   │  index.ts                │
                   │  errors.ts               │
                   └──────────────────────────┘
                              │
                   ┌──────────┴───────────────┐
                   │ Mongo                    │
                   │  bridgeVirtualAccounts   │
                   │  bridgeExternalAccounts  │
                   │  bridgeWithdrawals       │
                   │  Account.bridge*         │
                   └──────────────────────────┘

   Bridge POST ──► [reverse proxy / TLS] ──► port 4009
                                                │
                                                ▼
                               ┌────────────────────────────────────┐
                               │ bridge-webhook-server              │
                               │   /health                          │
                               │   /kyc       (RSA-SHA256 + lock)   │
                               │   /deposit   (RSA-SHA256 + lock)   │
                               │   /transfer  (RSA-SHA256 + lock)   │
                               └────────────────────────────────────┘

   IBEX  POST ──► [existing IBEX webhook ingress] ──► /crypto/receive
                                                          (token + lockPaymentHash)
```

## 2. Configuration

YAML config block (`yamlConfig.bridge`). Loaded via `BridgeConfig`. **Not**
env vars.

```yaml
bridge:
  enabled: true
  apiKey: "..."                              # secret; rotate via Bridge dashboard
  baseUrl: "https://api.bridge.xyz/v0"
  webhook:
    port: 4009
    timestampSkewMs: 300000                  # 5 minutes
    publicKeys:
      kyc: "-----BEGIN PUBLIC KEY-----\n..."
      deposit: "-----BEGIN PUBLIC KEY-----\n..."
      transfer: "-----BEGIN PUBLIC KEY-----\n..."
```

| Field | Required | Notes |
|---|---|---|
| `enabled` | yes | Master kill switch. False → every Bridge GraphQL op short-circuits with `INVALID_INPUT` / "Bridge integration is currently disabled". |
| `apiKey` | yes | Bridge-issued. Loaded into `BridgeClient` constructor. **Do not log.** |
| `baseUrl` | yes | Defaults to prod URL inside the client; env override via this field. |
| `webhook.port` | yes | Bound by `bridge-webhook-server`. |
| `webhook.timestampSkewMs` | yes | Replay window. 5 min covers ordinary clock drift; widen carefully. |
| `webhook.publicKeys.{kyc,deposit,transfer}` | yes | Per-endpoint PEMs. See SECURITY §10 for rotation. |

## 3. Deployment

> **TBD — link the chart / values file.** The repo doesn't ship k8s
> manifests; deployment lives in the charts repo (per `ci/tasks/open-charts-pr.sh`).

What the chart must do:

- Two pods/processes:
  1. **API server** — already exists; gains the Bridge GraphQL surface.
  2. **`bridge-webhook-server`** — new process from `src/servers/bridge-webhook-server.ts`. Exposes port 4009. Probe `GET /health`.
- Reverse proxy / ingress fronting port 4009 with TLS termination. The
  signature middleware uses the raw request body, so the proxy **must not
  rewrite the body** (no JSON re-serialization, no compression rewrite).
- Mongo connectivity for both processes.
- Config secrets mounted at the YAML path (`apiKey`, three webhook public
  keys).
- Logs shipped to the same sink as the rest of the platform; tracing namespace
  is `services.bridge` (set via `wrapAsyncFunctionsToRunInSpan`).

### Rollout order

1. Land chart change with `bridge.enabled: false`.
2. Deploy. Confirm `/health` is 200 on the new pod.
3. Confirm GraphQL still responds normally (Bridge ops return
   `BridgeDisabledError`).
4. Flip `bridge.enabled: true` in config; reload.
5. Smoke: hit `bridgeKycStatus` as a Level-2 user; expect `null` (or whatever
   matches their state).
6. Walk through the §6 alert table to confirm dashboards are populated.

### Rollback

- Flip `bridge.enabled: false` (no restart needed if config is hot-reloaded;
  otherwise restart API).
- Webhook server can stay running; Bridge will retry whatever was in flight.
- If webhook-server itself is bad, stop the process — Bridge accumulates
  retries server-side (see §7).

## 4. Health & liveness

| Endpoint / signal | Meaning | Action on failure |
|---|---|---|
| `GET :4009/health` → 200 `{status:"ok"}` | Webhook server up | Restart pod; check logs for unhandled exception. |
| API GraphQL responds | API server up | Standard API runbook. |
| Service-span emission `services.bridge.*` | Tracing pipeline alive | Standard tracing runbook. |
| Mongo writes to `bridgeWithdrawals` succeed | Repo healthy | Standard Mongo runbook. |
| `bridgeInitiateKyc` returns a `kycLink` for a known account | End-to-end Bridge API reachable | See §8 incident playbook. |

## 5. Data inspection

### Quick queries

```javascript
// Most recent N withdrawals across all accounts
db.bridgeWithdrawals.find().sort({createdAt:-1}).limit(20)

// All withdrawals for one account
db.bridgeWithdrawals.find({accountId: "<accountId>"}).sort({createdAt:-1})

// Stuck pending withdrawals (no completion webhook landed)
db.bridgeWithdrawals.find({status: "pending", createdAt: {$lt: new Date(Date.now()-3600*1000)}})

// External accounts not yet verified
db.bridgeExternalAccounts.find({status: "pending"})

// Accounts with KYC approved but no virtual account yet
db.accounts.find({bridgeKycStatus: "approved"})
   .filter(a => !db.bridgeVirtualAccounts.findOne({accountId: a._id}))

// Accounts with KYC rejected
db.accounts.find({bridgeKycStatus: "rejected"})
```

### Indexes that matter

- `Account.bridgeEthereumAddress` — sparse, used by IBEX `/crypto/receive`
  to look up the recipient account.
- `bridgeExternalAccounts (accountId, bridgeExternalAccountId)` — unique
  compound; **never drop** (CRIT-2 / ENG-281 cross-account safeguard).
- `bridgeWithdrawals.bridgeTransferId` — unique; transfer-state lookups.
- `bridgeVirtualAccounts.bridgeVirtualAccountId` — unique.

## 6. Alert response

Drawn from WEBHOOKS.md §6. Each row tells you what the alert means and the
first thing to check.

| Alert | Likely cause | First check |
|---|---|---|
| `bridge_webhook_signature_failures > 5/min` | Wrong public key in config, or someone scanning the endpoint. | Compare PEMs against Bridge dashboard. Look at source IPs in proxy logs. |
| `bridge_webhook_5xx_rate > 1/min` | Handler crash (likely Mongo issue or unhandled payload field). | Tail webhook-server logs for stack trace. Bridge will retry; do not panic. |
| `bridge_webhook_lock_contention > 10/min` | Bridge is replaying aggressively or duplicate keys are colliding. | Check `tx_hash` / `transfer_id` distribution in logs. |
| `bridge_pending_withdrawals_age_p99 > 24h` | Transfer webhook never landed, or Bridge transfer is genuinely stuck. | `db.bridgeWithdrawals.find({status:"pending",...})`; cross-reference Bridge dashboard. |
| `bridge_api_5xx_rate > 1/min` | Bridge upstream incident. | Bridge status page. Consider toggling `bridge.enabled: false` if widespread. |
| `bridge_api_429_rate > 0` | Rate-limit hit (no client backoff today). | Throttle callers; longer-term ENG-286. |
| `bridge_kyc_rejected_rate sudden spike` | Persona configuration drift, or a campaign of bad actors. | Sample recent rejections in `Account.bridgeKycStatus = "rejected"`. |

## 7. Bridge retry behavior

> **TBD — confirm exact schedule with Bridge support.** Documented behavior
> from observation:
>
> - Bridge retries failed webhooks with backoff (minutes → hours).
> - Each retry uses the same `t` and `v0` (same payload, same signature).
> - Lock-based dedup ensures repeated handler invocations are no-ops.
> - There is **no `Bridge-Retry-Count` header** documented; if one is added
>   later, surface it in logs.

Implication: a few minutes of webhook downtime is recoverable; longer
outages risk timestamp-skew rejections (default 5 min). For planned
downtime > 5 min, raise `bridge.webhook.timestampSkewMs` first or coordinate
with Bridge to pause replay.

## 8. Incident playbooks

### 8.1 "Bridge API is returning 5xx"

1. Check Bridge status page.
2. If confirmed upstream incident: flip `bridge.enabled: false`. New
   GraphQL calls fail-fast with `BridgeDisabledError`. In-flight Bridge
   webhooks still verify and apply (they don't go through the API client).
3. Comm: tell support to expect "Bridge integration is currently disabled"
   error from users.
4. When Bridge is back: flip `enabled: true`. Replay any backlog (Bridge
   webhooks self-replay; outbound failures are user-driven retries).

### 8.2 "User reports a withdrawal stuck in `pending` for > 24h"

1. `db.bridgeWithdrawals.findOne({bridgeTransferId: "..."})` — confirm we
   have the record.
2. Look up the same ID in the Bridge dashboard. Three sub-cases:
   - **Bridge says completed** → our `transferHandler` never fired or
     errored. Check webhook-server logs for the `transfer_id`. Likely a 5xx
     during processing; can manually invoke
     `BridgeAccountsRepo.updateWithdrawalStatus(transferId, "completed")`
     after corroborating.
   - **Bridge says failed** → same mitigation but with `"failed"`.
   - **Bridge says pending** → wait or escalate to Bridge support.
3. Send the user a manual update if the wait crosses the comm SLO.

### 8.3 "Webhook signature failures spiking"

1. Check time of last config change. If recent, you likely deployed an old
   key. Roll back the PEM.
2. If config is unchanged, Bridge may be rotating. Confirm with Bridge.
   Update PEM. Expect a brief overlap window (SECURITY §10).
3. If neither: capture sample request IPs / headers; this could be a probe.

### 8.4 "Cross-account withdrawal attempt detected"

The compound index `(accountId, bridgeExternalAccountId)` on
`bridgeExternalAccounts` should make this physically impossible (CRIT-2). If
the alert fires anyway:

1. Inspect the duplicate-key error in logs — extract `accountId`,
   `bridgeExternalAccountId`.
2. Confirm the legitimate owner in `bridgeExternalAccounts`.
3. Lock the attacking account (standard abuse runbook).
4. **Do not drop the index** to "fix" the error. The index is the safety
   net.

### 8.5 "IBEX `/crypto/receive` is logging deposits but balances aren't moving"

This is **expected today** — the route only logs (ENG-296). When the
wallet-credit logic lands, this becomes a real incident; until then file
the ENG-296 progress as the answer.

## 9. Backfill & replay

### 9.1 Replay a missed webhook

Bridge will retry on its own (§7). Manual replay procedure:

1. From Bridge dashboard → Webhooks → find the event.
2. Hit "Resend". Bridge resigns and POSTs again.
3. Lock-based dedup means repeats are safe even if the event already
   processed.

### 9.2 Reconcile transfer status

If you suspect drift between Mongo and Bridge:

```javascript
// Find pending withdrawals, fetch Bridge status, compare.
db.bridgeWithdrawals.find({status:"pending"}).forEach(w => {
  // Manual: lookup w.bridgeTransferId in Bridge dashboard, update if needed.
})
```

A scripted reconciler is **not in scope** for v0 of the runbook. Tracked:
new ticket TBD (likely under ENG-273).

### 9.3 Re-issue a virtual account

Today there is **no schema-level uniqueness** preventing multiple
`bridgeVirtualAccounts` rows for the same `accountId`. If a duplicate is
created accidentally:

1. Identify duplicates: `db.bridgeVirtualAccounts.aggregate([{$group:{_id:"$accountId",n:{$sum:1},ids:{$push:"$_id"}}},{$match:{n:{$gt:1}}}])`
2. Decide which Bridge VA is canonical (likely the most recent that received
   a deposit).
3. Mark / archive the others. Bridge-side, deactivate the unused VA via the
   dashboard.

A uniqueness constraint is recommended; track under the schema cleanup
ticket (TBD).

## 10. On-call cheatsheet

| Symptom | Most likely | First action |
|---|---|---|
| Users can't start KYC | Bridge API down, or `bridge.enabled: false` | Status page; check config flag. |
| Users can't create virtual account | Awaiting IBEX address (ENG-296) or KYC not approved | Check `Account.bridgeEthereumAddress`, `bridgeKycStatus`. |
| Withdrawal returns "Insufficient funds" but balance looks fine | Float-precision rounding (API §8.5) | Reduce amount slightly; raise ticket. |
| Withdrawal returns "External account not verified" | Bank link not yet confirmed by Bridge | User must wait for Bridge verification webhook. |
| Many `INVALID_INPUT` errors with no detail | Error-code collapse (API §8.4) | Read the `message` string — that's where the actual cause is. |

## 11. Open ops work

| Item | Tracking |
|---|---|
| Real chart / deployment manifest reference | Charts repo (link TBD) |
| Bridge retry schedule confirmed in writing | Ask Bridge support |
| Scripted Mongo↔Bridge reconciler | New ticket (likely under ENG-273) |
| Audit-log ledger | New ticket |
| Two-key webhook rotation overlap | New ticket |
| Idempotency keys on outbound calls | New ticket (related to ENG-286) |
| Wallet-credit + push on `/crypto/receive` | **ENG-296**, **ENG-275** |
| Sandbox E2E runbook section | **ENG-274** |
| Monitoring dashboards / formal alert wiring | **ENG-273** |

## Document History

| Date | Author | Change |
|---|---|---|
| 2026-04-22 | Taddesse (Dread review) | Initial v0 runbook for ENG-272. |
