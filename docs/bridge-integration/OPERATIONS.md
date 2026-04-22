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

### External deployment dependency — IBEX auth migration

Bridge depends on IBEX for the crypto leg (inbound USDT via
`/crypto/receive`, and the parent-account / child-address scheme that
provisions `Account.bridgeEthereumAddress`). IBEX is deprecating the
current auth scheme on **May 31, 2026**; after that date Flash must be
on the new M2M client-credentials auth or the IBEX calls that Bridge
relies on will fail.

- Tracked as **ENG-38** (owned by Ben, Urgent, due 2026-05-31). Not in
  the Bridge Wallet Integration project — tracked independently
  because it spans more than Bridge.
- **Deployment implication:** any Bridge production rollout planned on
  or after May 31, 2026 must ship with the IBEX auth migration
  already landed. If ENG-38 slips, the Bridge launch slips with it
  regardless of Bridge-side readiness.
- Incident fallback: if the auth cut happens before migration, flip
  `bridge.enabled: false` to stop accepting new deposits / withdrawal
  initiations; in-flight Bridge webhooks continue to verify and apply
  but the crypto leg (IBEX → wallet credit) will be down until ENG-38
  lands.

### Rollout order

1. Land chart change with `bridge.enabled: false`.
2. Deploy. Confirm `/health` is 200 on the new pod.
3. Confirm GraphQL still responds normally (Bridge ops return
   `BridgeDisabledError`).
4. Flip `bridge.enabled: true` in config; reload.
5. Smoke: hit `bridgeKycStatus` as a Level-2 user; expect `null` (or whatever
   matches their state).
6. Walk through the §6 alert table to confirm dashboards are populated.

### Cash Wallet opt-in rollout strategy (per 2026-04-22 architectural correction)

Per Dread's 2026-04-22 13:09 ET directive: Phase 1 is a **per-user, permanent, non-reversible opt-in** migration of the Cash Wallet from the legacy IBEX USD account to the new IBEX ETH-USDT account. The IBEX ETH-USDT account **IS** the Flash Cash Wallet (IBEX is the ledger; no parallel Flash-side USDT wallet). See FLOWS §3d for the state machine and LINEAR-PROPOSAL §1 for ENG-345/346 (opt-in).

Recommended rollout ordering — do **not** expose opt-in to users until all of these are green:

1. **Deploy with opt-in gated off.** `bridge.enabled: true` globally but the ENG-345/346 (opt-in) mutation is either feature-flagged off or returns "not yet available". Everybody is still on legacy USD.
2. **Verify the target wallet exists.** ENG-296 landed — Flash can provision an IBEX ETH-USDT account per user.
3. **Verify LN parity on the target wallet.** ENG-297 landed — LN invoice gen, LN pay, LNURL, balance, history all work against the IBEX ETH-USDT account. **If LN parity isn't proven, do not open the opt-in.** Opting a user in without LN parity is a Cash Wallet regression vs. legacy USD.
4. **Verify audit ledger is writing.** ENG-348 landed — every Bridge↔IBEX USDT movement produces an ERPNext audit row. Confirm on staging with at least one sandbox on-ramp + off-ramp.
5. **Verify Cashout V1 with ETH-USDT as the first-class source wallet.** ENG-357 landed (Bridge-side half) **and** the Cashout V1 project spec update is live (the opt-in decision tree). Cashout V1 defaults to ETH-USDT for opted-in users (with a USDT→USD swap step via IBEX before the JMD off-ramp), and falls back to legacy USD only for non-opted-in users. Smoke this with two JM test users on staging — one opted in (should source from ETH-USDT), one not (should source from legacy USD). Per Dread 2026-04-22 14:15 ET: ENG-296 is the cross-project gate for both halves.
6. **Internal dogfood wave.** Opt in the Flash team accounts first (10–30 users). Monitor: opt-in state transitions land cleanly (`legacy_usd → opt_in_pending → eth_usdt_ready → eth_usdt_active`), ERPNext audit rows write, LN send/receive works, Cashout V1 works for the JM testers, no stuck `opt_in_pending` rows.
7. **Limited external wave.** Open opt-in to a small country/user cohort (e.g. friends-and-family list) behind the same feature flag.
8. **Country-gated general availability.** Open opt-in to all users in the Flash country allowlist (ENG-347 — not the raw 86-country Bridge list).

**Rollback scope:** The opt-in state machine is **one-way terminal by design**. There is no user-facing rollback — once a user reaches `eth_usdt_active`, they stay there. Incident-only rollback = flip the opt-in mutation feature flag off (stops new opt-ins; does not reverse existing ones). If a user ends up in a broken `opt_in_pending` or `eth_usdt_ready` state, that's a state-machine bug to fix forward, not a "send them back to legacy USD" action.

**Data to save before cutting over any user:**

- Snapshot of the user's legacy IBEX USD wallet balance at the moment of opt-in (for audit / support / reconciliation).
- Snapshot of any pending in-flight transactions (LN invoices, outbound sends) — opt-in should be blocked while any of these are in-flight, not raced.
- The opt-in timestamp on the account row.

**Support-visible indicators on the account record after opt-in:**

- `cashWalletOptInState` = `eth_usdt_active`
- `cashWalletOptInAt` = timestamp
- `bridgeEthereumAddress` = populated (ENG-296 address)
- Legacy IBEX USD wallet balance = zero (or transferred out per migration policy — confirm with Dread + finance)

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

### 8.5 "IBEX `/crypto/receive` fired but no ERPNext audit row / no push landed"

**Framing correction (2026-04-22):** The IBEX ETH-USDT account **IS** the Flash Cash Wallet — IBEX is the ledger. The `/crypto/receive` webhook does **not** "credit a wallet" on the Flash side. Its job is (a) write an ERPNext audit row (ENG-348) and (b) emit a push notification (ENG-275). The Cash Wallet balance itself moves on IBEX's side inside the IBEX ETH-USDT account.

1. If the user is saying "my Cash Wallet didn't go up": this is an IBEX-side question. Check the IBEX dashboard for the ETH-USDT account balance. If IBEX shows the credit, the Cash Wallet *is* up — the app probably needs a refresh / balance re-fetch.
2. If the audit row is missing but the balance moved on IBEX: that's a ENG-348 bug (audit writer failed silently). File an incident on that ticket; finance can reconstruct the row from IBEX + Bridge dashboards in the meantime.
3. If no push landed but the balance moved on IBEX: that's an ENG-275 bug on the deposit-side push path.
4. If `/crypto/receive` never logged at all: check IBEX webhook delivery to Flash, `lockPaymentHash` idempotency collisions, and webhook-server logs.

### 8.6 "Opt-in stuck in `opt_in_pending`"

Per the state machine (FLOWS §3d), `opt_in_pending` means the user's opt-in request was accepted server-side but the ETH-USDT account provisioning (ENG-296) hasn't completed yet.

1. Confirm the account's `cashWalletOptInState` value.
2. Check Flash logs for the IBEX ETH-USDT account provisioning call (was it made? did it succeed?).
3. If provisioning succeeded but the state didn't advance: state-transition bug. Fix forward — do **not** attempt a rollback to `legacy_usd`.
4. If provisioning failed: retry the provisioning call. If it keeps failing, escalate to IBEX.

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
| Users can't see the deposit CTA | User hasn't opted in yet (state ≠ `eth_usdt_active`), or ENG-345/346 (opt-in) feature flag off, or user's country not on ENG-347 | Check `cashWalletOptInState` on account; check feature flag; check country allowlist. |
| Opt-in mutation rejected | ENG-296 or ENG-297 not ready, or ENG-345/346 (opt-in) feature flag off, or user has in-flight Cash Wallet activity | Check feature flag + dependency states. |
| User opted in but deposit CTA still hidden | Client cache / stale account state | Force a client refresh; confirm server-side `cashWalletOptInState = eth_usdt_active`. |
| Users can't create virtual account | KYC not approved, or ETH-USDT account provisioning (ENG-296) hasn't completed for this user | Check `Account.bridgeEthereumAddress`, `bridgeKycStatus`, `cashWalletOptInState`. |
| LN send/receive fails on an opted-in user's Cash Wallet | ENG-297 regression, or IBEX LN on ETH-USDT account issue | Smoke test via sandbox ETH-USDT account; escalate to IBEX if IBEX-side. |
| Cashout V1 failing for opted-in JM users | Cashout V1 source-wallet selection not defaulting to ETH-USDT (ENG-357 regression), or USDT→USD swap step failing | Check Cashout V1 source-wallet selection logic — for opted-in users it should default to ETH-USDT, fall back to legacy USD only when opt-in flag is absent. Verify the IBEX swap leg ran. |
| Withdrawal returns "Insufficient funds" but balance looks fine | Float-precision rounding (API §8.5), or balance is being read from legacy wallet when the user is opted in | Reduce amount slightly; confirm balance source = IBEX ETH-USDT for opted-in users. |
| Withdrawal returns "External account not verified" | Bank link not yet confirmed by Bridge | User must wait for Bridge verification webhook. |
| Many `INVALID_INPUT` errors with no detail | Error-code collapse (API §8.4) | Read the `message` string — that's where the actual cause is. |
| "My Cash Wallet balance didn't go up after a deposit" | Cash Wallet balance lives on IBEX ETH-USDT account; the app may be caching stale balance | Check IBEX dashboard; force client refresh. See §8.5. |

## 11. Open ops work

| Item | Tracking |
|---|---|
| Real chart / deployment manifest reference | Charts repo (link TBD) |
| Bridge retry schedule confirmed in writing | Ask Bridge support |
| Scripted Mongo↔Bridge reconciler | New ticket (likely under ENG-273) |
| Two-key webhook rotation overlap | New ticket |
| Idempotency keys on outbound calls | New ticket (related to ENG-286) |
| ETH-USDT Cash Wallet provisioning + Cash Wallet pointer flip | **ENG-296** |
| LN parity on ETH-USDT Cash Wallet (launch blocker) | **ENG-297** |
| Per-user permanent opt-in toggle + state machine | **ENG-345/346 (opt-in)** |
| ERPNext audit row per Bridge↔IBEX USDT movement | **ENG-348** (replaces the old "audit-log ledger" line) |
| Cashout V1: ETH-USDT as the first-class source wallet on re-launch (USDT→USD swap before JMD off-ramp); legacy USD fallback only for non-opted-in users. **ENG-296 is a cross-project launch blocker for both this project and Cashout V1** (Dread 2026-04-22 14:15 ET). | **ENG-357** (this project) + Cashout V1 project spec update (Dread) |
| Flash country allowlist (superset of Bridge's 86 countries) | **ENG-347** |
| Push notifications on deposit settlement + withdrawal completion | **ENG-275** (scope expanded to include deposit-side push) |
| Sandbox E2E runbook section (now incl. opt-in + LN parity + ERPNext audit row checks) | **ENG-274** |
| Monitoring dashboards / formal alert wiring (now incl. ERPNext-write-failure panel) | **ENG-273** |

## Document History

| Date | Author | Change |
|---|---|---|
| 2026-04-22 | Taddesse (Dread review) | Initial v0 runbook for ENG-272. |
| 2026-04-22 14:15 ET | Taddesse (Dread confirmation) | **Cashout V1 follow-up.** Updated §10 cheatsheet "Cashout V1 failing" row to reflect ETH-USDT-as-default selection logic. Updated §11 open-ops Cashout V1 row to call out **ENG-296 as cross-project launch blocker for both Bridge and Cashout V1** and to add the Cashout V1 project spec-update line item (Dread). |
| 2026-04-22 13:09 ET | Taddesse (Dread directive) | **IBEX-ETH-USDT-is-the-wallet cascade.** Added §3 Cash Wallet opt-in rollout strategy (8-step ordering: deploy gated → ENG-296 → ENG-297 → ENG-348 → ENG-357 → dogfood → limited cohort → country-gated GA; rollback is feature-flag-only because state machine is one-way terminal). Rewrote §8.5 from "expected — only logs" to the correct framing (IBEX is the ledger; `/crypto/receive` writes audit + push, not wallet credit) and added §8.6 "Opt-in stuck in `opt_in_pending`". Expanded §10 cheatsheet with opt-in / LN-parity / Cashout V1 / Cash Wallet balance source patterns. Rewrote §11 open-ops table to replace "wallet-credit" line with ENG-348 + ENG-345/346 (opt-in) + ENG-357 + ENG-347 + ENG-297, and reframed ENG-275 to cover deposit+withdrawal push. |
