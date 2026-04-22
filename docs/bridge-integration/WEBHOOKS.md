# Bridge Integration — Webhooks

> **Status:** Specification, aligned with code on `lnflash/flash:docs/bridge-integration-spec` @ `85af420`. The Bridge webhook server is fully implemented; the IBEX `/crypto/receive` handler is partially implemented (account/wallet lookup + lock + log).
>
> **Architectural note (Dread 13:09 ET):** earlier drafts described the IBEX `/crypto/receive` handler as the place where the user's wallet would be **credited**. That framing is wrong: **IBEX's ETH-USDT account IS the user's Cash Wallet**, so the balance has already moved on IBEX's side by the time this webhook fires. The Flash-side follow-on work on this handler is **(a) ERPNext audit-row write (`ENG-348`)** and **(b) push notification (`ENG-275`)** — not a wallet credit. The two-webhook model below is renamed accordingly.
>
> **Audience:** Flash backend engineers, ops/SRE, anyone configuring the Bridge dashboard or reverse-proxy in front of Flash.
>
> **Companion docs:** `ARCHITECTURE.md` (component layout, where the webhook server lives), `FLOWS.md` (flow-level behavior using these events), `SECURITY.md` (key rotation, threat model).

---

## §1. Purpose & Scope

The Bridge integration consumes events on **two distinct webhook surfaces**:

1. **Bridge webhook server** — a standalone Express process inside the Flash backend that receives signed events from Bridge.xyz (`POST /kyc`, `POST /deposit`, `POST /transfer`).
2. **IBEX webhook server** — Flash's pre-existing IBEX webhook receiver, with one new route (`POST /crypto/receive`) that handles inbound USDT-on-Ethereum deposits to user-owned child addresses.

These two surfaces together implement the **two-webhook deposit notification model** described in `ARCHITECTURE.md` §5.4 and visualized in §5 below: the Bridge `/deposit` event tells Flash that fiat landed in the Virtual Account (log + future ERPNext audit row); the IBEX `/crypto/receive` event tells Flash that USDT was received on chain into the user's IBEX ETH-USDT account — **which IS the Cash Wallet**, so the balance has already moved on IBEX's side. The IBEX webhook drives an ERPNext audit row + push notification, **not** a Flash-side wallet credit.

### Non-goals
- Outbound webhooks Flash *sends* to other systems — none exist as part of this integration.
- The mobile-app push-notification path that fires off the back of these webhooks — covered in `FLOWS.md` §4–§5 sequence diagrams.
- General Bridge event taxonomy beyond the events Flash currently subscribes to — see Bridge's own docs.

---

## §2. Bridge Webhook Server

### §2.1 Process & topology

- **Entry point:** `src/services/bridge/webhook-server/index.ts` (`startBridgeWebhookServer()`).
- **Runtime:** standalone Express instance in the same Node.js process as the main Apollo Server, but listens on its own port.
- **Port:** `BridgeConfig.webhook.port` (YAML config, `bridge.webhook.port`; default `4009`).
- **Body parsing:** `express.json()` with a `verify` callback that captures the raw UTF-8 body onto `req.rawBody`. Signature verification operates on `req.rawBody`, not on the parsed JSON — required because the signature was computed over the exact bytes Bridge sent.
- **Health check:** `GET /health` returns `200 { "status": "ok", "service": "bridge-webhook" }`. No signature required. Use this in load-balancer health probes.

> **Reverse-proxy requirement:** any ingress in front of the webhook server must preserve the raw request body. Do not enable JSON-rewriting, transcoding, or compression-decoding middleware between Bridge and `:4009` — it will invalidate the signature.

### §2.2 Endpoints

| Method | Path | Handler | Purpose |
|---|---|---|---|
| `POST` | `/kyc` | `routes/kyc.ts` → `kycHandler` | KYC status transitions |
| `POST` | `/deposit` | `routes/deposit.ts` → `depositHandler` | Bridge-side fiat-landed log |
| `POST` | `/transfer` | `routes/transfer.ts` → `transferHandler` | Off-ramp transfer status |
| `GET` | `/health` | inline | Liveness probe |

> **The paths are exactly `/kyc`, `/deposit`, `/transfer` at the server root** — not `/bridge/webhooks/{kyc,deposit,transfer}` as some prior drafts said. Configure the Bridge dashboard with the public URL Flash exposes for port 4009 (e.g., `https://webhooks.flash.example/kyc`).

### §2.3 Signature verification

Implementation: `middleware/verify-signature.ts` (`verifyBridgeSignature(publicKeyType)`).

**Header format** (single combined header, Stripe-style):
```
X-Webhook-Signature: t=<timestamp_ms>,v0=<base64_signature>
```

Where:
- `t=<timestamp_ms>` — Bridge's signing time in **Unix epoch milliseconds** (not seconds).
- `v0=<base64_signature>` — base64-encoded RSA-SHA256 signature.

**Verification steps** (executed before any handler):
1. Read `X-Webhook-Signature`. Missing → `401 { "error": "Missing signature" }`.
2. Parse `t=...` and `v0=...` parts. Malformed → `401 { "error": "Invalid signature format" }`.
3. **Skew check:** compute `Math.abs(Date.now() - parseInt(timestamp))`. If greater than `BridgeConfig.webhook.timestampSkewMs` (default `300_000` ms = 5 min) → `401 { "error": "Timestamp too old" }`.
4. Look up the public key for this route from `BridgeConfig.webhook.publicKeys[publicKeyType]` where `publicKeyType ∈ {"kyc","deposit","transfer"}`. **Each route uses a distinct key** so compromise of one is contained to that event family.
5. Construct payload: `${timestamp}.${rawBody}`.
6. Verify with Node's `crypto.createVerify("RSA-SHA256")`. Invalid → `401 { "error": "Invalid signature" }`. Crash inside verifier → `500 { "error": "Signature verification failed" }`.
7. On success, `next()` — control passes to the route handler.

### §2.4 Idempotency

Each route handler wraps its work in `LockService().lockIdempotencyKey(lockKey)`. The lock is held in Redis. If the key is already held (Bridge retried), the handler short-circuits to `200 { "status": "already_processed" }`.

| Route | Lock key shape |
|---|---|
| `/kyc` | `bridge-kyc:${customer_id}:${event}` |
| `/deposit` | `bridge-deposit:${transfer_id}` |
| `/transfer` | `bridge-transfer:${transfer_id}` |

Note: KYC includes `event` in the key (so an `approved` and a later `rejected` for the same customer don't collide); deposit and transfer use only the resource ID (so any retry of any event for that resource collides into the existing lock — appropriate because the handler is doing one logical update per resource).

### §2.5 Response codes

| Code | When | Bridge behavior |
|---|---|---|
| `200` | Event processed OK, or already processed (lock held) | No retry. |
| `400` | Missing required fields in `data` (e.g., no `customer_id`, no `transfer_id`, no `event`) | Bridge will retry — **but the request will keep failing** until the payload is fixed upstream. Treat 400s in logs as a Bridge-vs-Flash schema mismatch alarm. |
| `401` | Signature missing / malformed / skewed / invalid | Bridge will retry. Persistent 401s indicate either (a) a public-key mismatch (rotation drift) or (b) a forged caller. |
| `404` | (KYC only) `findByBridgeCustomerId` returned not-found | Bridge will retry. Persistent 404s mean Flash deleted/never persisted the customer mapping. |
| `500` | DB write failure, signature-verifier crash, uncaught error | Bridge will retry per its retry schedule. |

---

## §3. Bridge Event Handlers

### §3.1 `kycHandler` (`POST /kyc`)

**Subscribes to:** `kyc.approved`, `kyc.rejected`.

**Payload shape (relevant fields):**
```json
{
  "event": "kyc.approved" | "kyc.rejected",
  "data": {
    "customer_id": "<bridge customer id>",
    "kyc_status": "approved" | "rejected",
    "reason": "<string, present on rejection>"
  }
}
```

**Behavior:**
1. Validate `customer_id` and `event` are present (else `400`).
2. Acquire idempotency lock `bridge-kyc:${customer_id}:${event}`.
3. Resolve the Flash account via `AccountsRepository().findByBridgeCustomerId(customer_id)` (else `404`).
4. On `kyc.approved`: `updateBridgeFields(account.id, { bridgeKycStatus: "approved" })`. Log `info` "Bridge KYC approved".
5. On `kyc.rejected`: same update with `"rejected"`, plus log `warn` including `reason`.
6. `200 { "status": "success" }`.

**Events not currently handled:** Bridge's webhook taxonomy includes finer-grained events (e.g., `kyc.under_review`, `kyc.offboarded`, `kyc_link.completed`). The `bridgeKycStatus` schema field has values for these (`under_review`, `offboarded`), but the handler currently only branches on `approved` / `rejected`. Adding the additional branches is **straightforward** and is captured under §8 open work — recommend doing this together with `ENG-273` (monitoring) so we get visibility into how often non-handled events arrive.

### §3.2 `depositHandler` (`POST /deposit`) — log-only today; will write ERPNext audit row

**Subscribes to:** any deposit-family event (current code does not branch on `event` value; it simply destructures `transfer_id` and logs).

**Payload shape (relevant fields):**
```json
{
  "event": "deposit.completed" | <any other deposit event>,
  "data": {
    "transfer_id": "<bridge transfer id for the on-ramp leg>",
    "amount": "<string>",
    "currency": "<string>",
    "tx_hash": "<eth tx hash, if known>",
    "customer_id": "<bridge customer id>"
  }
}
```

**Behavior:**
1. Validate `transfer_id` and `event` are present (else `400`).
2. Acquire idempotency lock `bridge-deposit:${transfer_id}`.
3. **Log `info` "Bridge deposit completed"** with the full payload. Do nothing else.
4. `200 { "status": "success" }`.

**Why log-only today?** Two reasons. First: there is no Flash-side wallet ledger to credit — IBEX's ETH-USDT account IS the Cash Wallet, and the balance only moves once IBEX actually receives the USDT settlement (signaled via `/crypto/receive`, §4). Second: the audit/accounting work that *does* belong on this handler — writing an ERPNext row recording the Bridge-side fiat landing — is not yet implemented (see `ENG-348`).

The Bridge `/deposit` log line is critical today for **reconciliation visibility**: if the IBEX event never arrives within the SLA window (24h is the working assumption — see `FLOWS.md` §6 / `ENG-276` reconciliation worker), the Bridge log is what tells ops "Bridge says fiat landed; we're waiting on IBEX." Once `ENG-348` lands, the same data will be in ERPNext as a structured audit row.

> **What this handler will NOT do, ever:** credit a Flash-side wallet ledger. There is no such ledger — IBEX is the ledger.

### §3.3 `transferHandler` (`POST /transfer`)

**Subscribes to:** `transfer.completed`, `transfer.failed`.

**Payload shape (relevant fields):**
```json
{
  "event": "transfer.completed" | "transfer.failed",
  "data": {
    "transfer_id": "<bridge transfer id>",
    "state": "<bridge state string>",
    "amount": "<string>",
    "currency": "<string>"
  }
}
```

**Behavior:**
1. Validate `transfer_id` and `event` are present (else `400`).
2. Acquire idempotency lock `bridge-transfer:${transfer_id}`.
3. Resolve the `BridgeWithdrawalRecord` and call `BridgeAccountsRepo.updateWithdrawalStatus(transfer_id, status)`:
   - `transfer.completed` → status `"completed"`. Log `info` "Bridge transfer completed".
   - `transfer.failed` → status `"failed"`. Log `warn` "Bridge transfer failed" with `state`.
4. `200 { "status": "success" }`.

**Push notification:** the handler currently has `// TODO: Send push notification to user` comments on both branches. This is `ENG-275` (Laurent) and is the only user-facing piece missing for the off-ramp completion path — until it lands, the user must refresh manually to see the new status.

**Refunds / reversals:** there is no `transfer.refunded` branch implemented. Bridge's spec does include refund / reversal events (e.g., for ACH returns days later); these are not yet handled. Tracked under §8 open work.

---

## §4. IBEX `/crypto/receive` Webhook (the on-ramp settlement signal)

This route lives on the **existing** IBEX webhook server, **not** on the Bridge webhook server. It is the authoritative signal that USDT has settled to the user's IBEX ETH-USDT account on chain — i.e., **the Cash Wallet balance has gone up on IBEX's side**. Flash does not "credit" anything in response; the work is audit + push notification.

### §4.1 Path, auth, payload

- **File:** `src/services/ibex/webhook-server/routes/crypto-receive.ts`.
- **Path:** `POST /crypto/receive` (note: `/crypto/receive` with a slash, not `/crypto-receive`).
- **Mounted on:** the IBEX webhook router (existing infrastructure).
- **Middleware (in order):** `authenticate` (token-based — IBEX uses bearer-style auth, not RSA signatures), `logRequest`, then the handler. This is the same auth pattern as the rest of the IBEX webhook server; it does **not** use Bridge's RSA-SHA256 signature scheme.

**Required payload:**
```json
{
  "tx_hash": "<on-chain transaction hash>",
  "address": "<flash account's bridgeEthereumAddress>",
  "amount": <number>,
  "currency": "USDT",
  "network": "ethereum"
}
```

The handler **strictly requires** `currency === "USDT"` and `network === "ethereum"` — anything else returns `400`. The `network` discriminator is what scopes this route to the Bridge integration's ETH path (vs. any future Tron or other chain handling).

### §4.2 Behavior + current limitations

1. Validate payload (else `400 { "error": "Invalid payload" }`).
2. Acquire `LockService().lockPaymentHash(tx_hash, asyncFn)` — wraps the work in a callback, locking on the on-chain tx hash.
3. Inside the lock:
   1. Look up the account: `AccountsRepository().findByBridgeEthereumAddress(address)` (else status code 404 — see §4.4).
   2. List the account's wallets: `listWalletsByAccountId(account.id)` (else 500).
   3. Find the USDT wallet (`wallets.find(w => w.currency === WalletCurrency.Usdt)`) (else 404).
   4. Convert `amount` to `USDTAmount` (else 400).
   5. **Log `info` "USDT deposit received"** with `accountId`, `walletId`, `amount`, `tx_hash`, `address`.
   6. Return `{ status: "success" }`.

**Critical current limitation:** step 3.5 is the **last step in the current code**. The handler does **not yet write an ERPNext audit row** (`ENG-348`) and **does not yet send a push notification** (`ENG-275`). Both are being held until `ENG-296` lands so end-to-end is testable.

> **Important framing correction (Dread 13:09 ET):** earlier drafts of this section described the missing work as "credit the user's USDT wallet ledger." That is wrong — there is no Flash-side USDT wallet ledger to credit. The IBEX ETH-USDT account IS the Cash Wallet; the balance has already moved on IBEX's side by the time this webhook fires. The two real follow-on items are the ERPNext audit row and the push notification. The in-source `// TODO` comments still use the old wording and should be updated when the work lands.

Treat any production firing of this webhook today as an alert condition (see §6.5) — not because the user is missing a credit, but because the audit + notification path is not wired.

### §4.3 Idempotency

Idempotency model differs slightly from the Bridge handlers:
- Uses `LockService().lockPaymentHash(tx_hash, asyncFn)` — a callback-style lock (not the get-or-fail-style `lockIdempotencyKey`).
- The `tx_hash` is the lock key. Because IBEX delivers the same `tx_hash` for retries of the same on-chain event, this collapses retries to a single execution.
- If the lock acquisition itself returns an error (already held, Redis failure), the handler responds `200 { "status": "already_processed" }` — same outward behavior as the Bridge handlers.

### §4.4 Response codes

| Code | When |
|---|---|
| `200 { status: "success" }` | Successfully logged the deposit. |
| `200 { status: "already_processed" }` | Lock already held (duplicate webhook). |
| `400 { error: "Invalid payload" }` | Missing fields, wrong currency, wrong network. |
| `400 { error: "invalid_amount" }` | `USDTAmount.fromNumber(amount)` rejected the value. |
| `404 { error: "account_not_found" }` | No Flash account has this `bridgeEthereumAddress` — orphan deposit. |
| `404 { error: "usdt_wallet_not_found" }` | Account exists but has no USDT wallet — should not happen post-ENG-296 because account provisioning will create the wallet. Today, possible. |
| `500 { error: "wallet_list_failed" }` | DB error listing wallets. |
| `500 { error: "internal_error" }` | Uncaught exception. |

The 404 cases are the **orphan-deposit path** in `FLOWS.md` §6 — they require manual reconciliation and should fire an ops alert.

---

## §5. Two-Webhook Deposit Notification Model

Cross-reference to `ARCHITECTURE.md` §5.4 — the same diagram is reproduced here for context, with the webhook details filled in.

```
   Bridge                          Flash :4009          IBEX                         Flash IBEX webhook
   (USD lands in VA)               webhook server       (USDT settled to user's      server
                                                         ETH-USDT account =
                                                         the Cash Wallet)
        │                                │                    │                           │
        │── POST /deposit ──────────────►│                    │                           │
        │   X-Webhook-Signature:         │                    │                           │
        │     t=<ms>,v0=<sig>            │── log + (TODO      │                           │
        │   { event, data: {transfer_id, │   ENG-348)         │                           │
        │     amount, currency, tx_hash, │   audit row        │                           │
        │     customer_id} }             │   audit row        │                           │
        │                                │                    │                           │
        │── (Bridge sends USDT to        │                    │                           │
        │    user's bridgeEthereumAddr)──┼───────────────────►│ (Cash Wallet balance      │
        │                                │                    │  moves on IBEX side —     │
        │                                │                    │  this account IS the      │
        │                                │                    │  Cash Wallet)             │
        │                                │                    │                           │
        │                                │                    │── POST /crypto/receive ──►│
        │                                │                    │   Authorization: <token>  │
        │                                │                    │   { tx_hash, address,     │── lookup account by
        │                                │                    │     amount, currency:     │   bridgeEthereumAddress
        │                                │                    │     "USDT",               │── log "USDT received"
        │                                │                    │     network: "ethereum"}  │── (TODO ENG-348:        
        │                                │                    │                           │    ERPNext audit
        │                                │                    │                           │    row)
        │                                │                    │                           │── (TODO ENG-275:
        │                                │                    │                           │    send push)
        │                                │                    │                           │
        │                                │                    │                           ▼
        │                                │                    │                       (no Flash-side
        │                                │                    │                        wallet credit;
        │                                │                    │                        IBEX is the ledger)
```

**Why two webhooks instead of one?** Bridge's event tells us *fiat* arrived in the VA; IBEX's event tells us *USDT* settled on chain into the user's IBEX ETH-USDT account (= the Cash Wallet). Both are needed for accurate accounting — the spread between them is "in flight" for ops/finance reconciliation. **Neither writes a Flash-side wallet ledger entry**, because there is no Flash-side wallet ledger; IBEX is the ledger.

---

## §6. Operational Concerns

### §6.1 Replay / retry behavior

- **Bridge:** retries 5xx and signature-failure responses on its own schedule (typically exponential backoff over ~24h). Idempotency lock keys make retries safe.
- **IBEX:** same retry expectation; idempotency via `lockPaymentHash`.

### §6.2 Reverse-proxy / ingress

- **Raw body must be preserved.** No body-rewriting, no JSON canonicalization, no compression-decoding middleware between Bridge and the webhook server (see §2.1). Same applies to IBEX.
- **HTTPS termination:** signature validity does not depend on TLS, but the webhook URL exposed to Bridge **must** be HTTPS — Bridge will refuse HTTP webhook URLs in production.
- **Hostname:** Flash decides; the path is fixed (`/kyc`, `/deposit`, `/transfer`). Conventionally use a dedicated `webhooks.<env>.<domain>` host so the webhook server can be moved or scaled independently of the Apollo server.

### §6.3 Public-key rotation

- Today: rotation requires editing the YAML config and restarting the process (no hot-reload of `BridgeConfig.webhook.publicKeys`).
- For zero-downtime rotation, Bridge's typical model is to issue a new key and accept signatures from either old-or-new during a grace window; the middleware does not currently support this (single key per route). Captured under §8 open work.

### §6.4 Health checks

- `GET :4009/health` for the Bridge webhook server (no auth, returns `200 { status: "ok", service: "bridge-webhook" }`).
- The IBEX webhook server has its own existing health check; not changed by this integration.

### §6.5 Suggested alerts (to be wired by ENG-273)

| Alert | Condition | Why |
|---|---|---|
| `bridge_webhook_signature_failures_high` | > N `401`s per minute on any Bridge route | Either key drift after rotation, or forged caller |
| `bridge_webhook_400_rate_high` | > N `400`s per minute on any Bridge route | Bridge schema change or upstream payload bug |
| `bridge_kyc_unknown_customer` | Any `404` on `/kyc` | Mongo lost the `bridgeCustomerId` mapping |
| `bridge_transfer_failed` | Any `transfer.failed` event handled | User-visible withdrawal failure; needs follow-up |
| `bridge_deposit_no_ibex_followup` | A `/deposit` log line with no matching `/crypto/receive` within 24h | Orphan deposit; reconciliation needed |
| `crypto_receive_account_not_found` | Any `404 account_not_found` on `/crypto/receive` | Orphan on-chain deposit — manual reconciliation |
| `crypto_receive_usdt_wallet_not_found` | Any `404 usdt_wallet_not_found` | Account provisioning bug (post-ENG-296) |

---

## §7. Open Work

| Linear | Description | Severity | Notes |
|---|---|---|---|
| **ENG-296** | IBEX ETH-USDT account / address provisioning. The provisioned account IS the Cash Wallet. | **Critical** | Until this lands, there is no new wallet to opt users into and the `/crypto/receive` handler has no real account to look up. |
| **ENG-348** | ERPNext audit-row writer for `/deposit` (Bridge accepted fiat) and `/crypto/receive` (USDT settled) | High | Replaces the old "wallet credit" framing. Also covers the off-ramp `/transfer` leg. |
| **ENG-275** | Push notifications on `/crypto/receive` (deposit completed) and `/transfer` (off-ramp `completed` / `failed`) | Med | `// TODO` in `transferHandler` and absent in `crypto-receive` handler. Owner: Laurent. |
| ENG-273 | Webhook monitoring / alerting (the §6.5 alerts) | Med | Owner: Nick. |
| ENG-276 | Reconciliation worker (deposit-no-ibex-followup, stuck transfers) | Med | Owner: Nick. Backstop for the 24h-no-IBEX alert. |
| (no ticket yet) | Handle additional KYC events: `kyc.under_review`, `kyc.offboarded`, `kyc_link.completed` | Low | Schema field already supports these states. |
| (no ticket yet) | Handle `transfer.refunded` (ACH return) and other Bridge transfer events beyond completed/failed | Low | Bridge spec has more states than the current 2-branch handler handles. |
| (no ticket yet) | Hot-swap public keys (zero-downtime rotation) | Low | Currently requires process restart. |
| (no ticket yet) | Webhook event replay endpoint for ops (re-fire a webhook from Bridge dashboard or a stored event log) | Low | Useful for incident recovery. |

---

## §8. Document History

| Date | Change | Author |
|---|---|---|
| 2026-04-21 | Full rewrite, grounded in actual handler code (`webhook-server/index.ts`, `routes/{kyc,deposit,transfer}.ts`, `middleware/verify-signature.ts`, `ibex/webhook-server/routes/crypto-receive.ts`). Corrections: port (4009 not 3005), root paths (no `/bridge/webhooks/` prefix), single combined `X-Webhook-Signature: t=...,v0=...` header (not separate Bridge-Signature/Bridge-Timestamp), timestamp in milliseconds (not seconds), per-endpoint public keys, real lock-key shapes, real response codes, exact event payloads. Added IBEX `/crypto/receive` route documentation (missing entirely from prior doc). Added two-webhook model diagram, operational concerns, and §7 open-work table. Called out current credit-logic gap and `// TODO` push notifications. | Taddesse + Dread |
| 2026-04-22 | **Architectural correction (Dread, 13:09 ET):** removed "wallet credit" framing throughout. IBEX ETH-USDT account IS the Cash Wallet; webhooks drive audit + push, not bookkeeping. §1 status note + scope rewritten; §3.2 `depositHandler` rationale rewritten; §4 IBEX `/crypto/receive` reframed as "settlement signal" (not "credit path"); §4.2 limitation paragraph rewritten with correct framing; §5 diagram redrawn; §7 open-work table updated with `ENG-348` and ENG-275 expanded to cover deposit push as well. | Taddesse + Dread |
| (prior) | 65-line draft with Tron mentions, wrong port, wrong paths, made-up headers, missing IBEX route. | heyolaniran et al. |
