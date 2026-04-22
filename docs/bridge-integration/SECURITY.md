# Bridge.xyz Integration — Security Model

> Aggregates security-relevant material from ARCHITECTURE.md, WEBHOOKS.md, and
> API.md into one reviewable surface. Every claim is sourced from
> `docs/bridge-integration-spec @ 85af420`.

## 1. Threat Surfaces

| Surface | Inbound trust source | Outbound trust target | Relevant docs |
|---|---|---|---|
| GraphQL (public) | User session via `GraphQLPublicContextAuth` | None | API.md, ARCHITECTURE §3 |
| Bridge webhook server (port 4009) | Bridge-signed POST bodies | None | WEBHOOKS §2, this doc §2 |
| IBEX `/crypto/receive` | Token-authenticated POST from IBEX | None | WEBHOOKS §4, this doc §3 |
| Bridge HTTP client | None (initiated by service) | `https://api.bridge.xyz/v0` with `Api-Key` header | this doc §4 |
| Mobile KYC iframe | Bridge → Persona/Plaid (loads directly) | None | this doc §6 |
| Mongo (`bridgeVirtualAccounts`, `bridgeExternalAccounts`, `bridgeWithdrawals`) | Service-layer writes only | None | ARCHITECTURE §6, this doc §5 |

## 2. Inbound: Bridge webhook authentication

**Source:** `src/services/bridge/webhook-server/middleware/verify-signature.ts`

- **Header:** Single Stripe-style header `X-Webhook-Signature: t=<ms>,v0=<sig>`
  where `t` is a millisecond timestamp and `v0` is base64-encoded RSA-SHA256
  of `<t>.<raw-body>`.
- **Verifier:** Node `crypto.createVerify("RSA-SHA256")` against a
  per-endpoint public key.
- **Per-endpoint public keys:** Three distinct keys configured under
  `bridge.webhook.publicKeys.{kyc,deposit,transfer}`. Each route's middleware
  loads only its own key. **Key rotation is per-endpoint** (see §10).
- **Replay protection:** Configurable `bridge.webhook.timestampSkewMs`
  (default `300000` = 5 min). Requests outside the window are rejected with
  401 before signature verification.
- **Raw body:** Captured at parse time via the `verify` callback on
  `express.json({ verify })` so the signature payload is byte-exact.
- **Idempotency:** Each handler acquires a lock via
  `LockService().lockIdempotencyKey(key)` (transfer, deposit) or
  `lockPaymentHash(tx_hash)` (IBEX `/crypto/receive`). Lock key shapes:

  | Route | Key shape |
  |---|---|
  | `/kyc` | `bridge-kyc:${customer_id}:${event}` |
  | `/deposit` | `bridge-deposit:${transfer_id}` |
  | `/transfer` | `bridge-transfer:${transfer_id}` |
  | `/crypto/receive` | `tx_hash` (cast through `lockPaymentHash`) |

  Lock acquisition failure is treated as a duplicate — the handler returns
  `200 { status: "already_processed" }` and exits.

**Failure modes & responses**

| Condition | HTTP | Behavior |
|---|---|---|
| Missing/malformed `X-Webhook-Signature` | 401 | `BridgeWebhookValidationError`-equivalent string (server-only). |
| Timestamp skew exceeded | 401 | Same. |
| Signature does not verify against per-endpoint key | 401 | Same. |
| Signature OK but handler errors | 500 | Logged; Bridge will retry. |
| Duplicate (lock contention) | 200 | `already_processed` — no further work. |

## 3. Inbound: IBEX `/crypto/receive`

**Source:** `wh-crypto-receive.ts` (sketch in `/tmp/bridge-docs/`)

- **Auth:** Token-based (`authenticate` middleware), **not** RSA. Differs
  from the Bridge webhook server. Lives on a separate ingress (the IBEX
  webhook namespace, not port 4009).
- **Payload validation:** Requires `currency: "USDT"` and
  `network: "ethereum"`; anything else returns 400.
- **Idempotency:** `LockService().lockPaymentHash(tx_hash)`.
- **Behavior today:** Logs only — no wallet credit, no push notification.
  Tracked under **ENG-296** (broader scope).

> **Note for security review:** The IBEX route shares wallet-side trust with
> the rest of the IBEX webhook surface. The token authenticator is the same
> one used for Lightning notifications; no Bridge-specific trust additions.

## 4. Outbound: Bridge API client

**Source:** `src/services/bridge/client.ts`

- **Auth header:** `Api-Key: <BridgeConfig.apiKey>`. **Not** Bearer, not
  HMAC-signed. Single secret rotated by Bridge dashboard.
- **TLS:** Default Node `fetch` to `https://api.bridge.xyz/v0`.
- **Idempotency:** Client supports an optional `Idempotency-Key` header
  (passed as a parameter on all mutating methods). **The service layer
  passes none today.** This is the root cause of the no-idempotency gap on
  `bridgeInitiateWithdrawal` (API §8.3) — a fix only requires the service
  to compute a stable key and forward it.
- **Retries:** None. Single `fetch` per call.
- **Timeout:** None set on `fetch` — depends on Node's default. Tracked under
  **ENG-286** (circuit breaker).
- **Error handling:** Throws `BridgeApiError` (note: client-local class,
  collides in name with the domain class in
  `src/services/bridge/errors.ts`; the service-level wrapper catches and
  rethrows). Non-2xx responses include `statusCode` + `response` body for
  ops logging.

> **Recommendation for security hardening:**
> 1. Add `Idempotency-Key` plumbing through the service layer.
> 2. Set an explicit fetch timeout (e.g. 15s) and route through a circuit
>    breaker.
> 3. Verify the API key is loaded from the YAML config path and never
>    logged. (The `apiKey` field is read via `BridgeConfig.apiKey`; confirm
>    no `console.log(BridgeConfig)` or pino-redaction gap.)

## 5. Data at rest — PII boundary

**Sources:** `src/services/mongoose/schema.ts:329-351, 612-661`

### What Flash stores (Mongo)

Three Bridge-specific collections plus three new fields on the existing
`Account` document:

```text
Account (additions)
  bridgeCustomerId            // Bridge's opaque customer ID
  bridgeKycStatus             // enum: pending | approved | rejected
  bridgeEthereumAddress       // sparse-indexed; nullable

bridgeVirtualAccounts
  accountId
  bridgeVirtualAccountId      // unique
  bankName, routingNumber, accountNumberLast4
  createdAt

bridgeExternalAccounts
  accountId
  bridgeExternalAccountId     // unique
  bankName, accountNumberLast4
  status                      // enum: pending | verified | failed
  createdAt
  + COMPOUND INDEX: { accountId, bridgeExternalAccountId } UNIQUE
    (CRIT-2 / ENG-281: prevents cross-account ownership even if app-layer
     check is bypassed)

bridgeWithdrawals
  accountId
  bridgeTransferId            // unique
  amount, currency
  status                      // enum: pending | completed | failed
  externalAccountId
  createdAt, updatedAt
```

### What Flash does **not** store

- US PII (full name, DOB, address, SSN, ID images). Persona/Plaid collect
  this **directly inside Bridge's iframe**. Flash never touches it.
- Full bank account numbers — only `accountNumberLast4`.
- Bank statements, tax docs, source-of-funds attestations.

### Existing JM PII

Stored in **Frappe ERPNext** as before. Unchanged by this integration. The
`bridgeKycStatus` field on `Account` is independent of the JMD KYC flow.

### Logging hygiene to enforce

- `BridgeConfig.apiKey` must never be logged.
- `tx_hash`, `bridgeTransferId`, `bridgeCustomerId` are OK to log (opaque
  identifiers).
- `accountNumberLast4` is OK to log.
- Webhook payloads can be logged at `info` only after redaction of any
  customer name/email if Bridge starts including them.

## 6. KYC iframe trust model

- The mobile app loads `kycLink` (returned by `bridgeInitiateKyc`) and
  `tosLink` directly from Bridge. The iframe origin is Bridge's; Persona /
  Plaid load as third-party iframes within that.
- Backend involvement ends at issuing the link. There is no Flash-side proxy.
- Backend learns the outcome via the `/kyc` webhook (`kyc.approved` /
  `kyc.rejected`) which updates `account.bridgeKycStatus`.
- **Bridge ToS acceptance** is currently implicit (the user clicks through in
  the iframe). ENG-343 will add an explicit Flash-side
  ToS-acceptance/profile-collection mutation so we have a recorded receipt.

## 7. Cross-account / authorization safeguards

| Safeguard | Where enforced | Source |
|---|---|---|
| Account level ≥ 2 for every Bridge op | GraphQL resolver + service layer | API §2 |
| User must own the external account before withdrawal | Service-layer scan + DB compound index | API §4.4 (CRIT-2/ENG-281) |
| External account must be `status === "verified"` | Service layer | API §4.4 |
| USDT balance check before transfer | Service layer | API §4.4 (CRIT-1/ENG-280) |
| No-existence-leak on missing/foreign external account | Service returns `"External account not found"` regardless of cause | svc/index.ts:407 |
| KYC-state branching on virtual-account creation | Service layer | API §4.2 |
| `bridgeAddExternalAccount` does **not** require KYC | By design — allows linking pre-approval | API §4.3 |

## 8. Transport security

- Bridge API: TLS via `fetch`. No certificate pinning.
- Webhook ingress: TLS terminates at the reverse proxy in front of port 4009
  (deployment-specific; document in OPERATIONS §3).
- IBEX `/crypto/receive`: TLS terminates at the existing IBEX-webhook
  ingress; same posture as other IBEX routes.

## 9. Secret management

| Secret | Storage | Loaded as | Rotation |
|---|---|---|---|
| `bridge.apiKey` | YAML config | `BridgeConfig.apiKey` | Manual via Bridge dashboard → config reload |
| `bridge.webhook.publicKeys.kyc` | YAML config | per-endpoint middleware | Bridge-initiated, see §10 |
| `bridge.webhook.publicKeys.deposit` | YAML config | per-endpoint middleware | Bridge-initiated, see §10 |
| `bridge.webhook.publicKeys.transfer` | YAML config | per-endpoint middleware | Bridge-initiated, see §10 |

> Webhook **public** keys are not secrets in the cryptographic sense, but
> their integrity is — accepting a swapped public key would let any signer
> succeed. Treat them with the same provenance discipline as private keys.

## 10. Webhook key rotation

There is **no in-band rotation mechanism** today. Procedure for ops:

1. Bridge announces (or proactively rotates) one of the three webhook
   keypairs.
2. Ops obtains the new public key (PEM) from the Bridge dashboard.
3. Update `bridge.webhook.publicKeys.<endpoint>` in YAML config.
4. Reload config / restart the webhook server (port 4009).
5. **Brief overlap window:** during the swap, in-flight Bridge retries
   signed with the old key will fail signature verification (401). Bridge
   will retry per its schedule; expect the queue to drain after the new key
   is live.

Recommendation (future): support **two keys per endpoint** so the new key
can be installed before Bridge cuts over. Tracked: new ticket TBD.

## 11. Audit trail

What's recorded today:

- Every service-layer operation logs `{ accountId, operation, ... }` at
  `baseLogger.info` start + completion (and `.error` on failure).
- Every webhook handler logs the event payload + any state changes.
- Lock-key contention (duplicate webhook) logs at `info`.

What's missing:

- A dedicated `bridge_audit_log` collection or append-only ledger that ties
  external Bridge transfer IDs back to internal user/wallet/balance impacts
  in one query. Today this requires correlating logs + multiple Mongo
  collections. Tracked: new ticket TBD (likely combined with **ENG-273**
  monitoring work).

## 12. Open security work

| Item | Severity | Tracking |
|---|---|---|
| No outbound idempotency key on `bridgeInitiateWithdrawal` | High (financial double-spend on retry) | new ticket TBD |
| No timeout / circuit breaker on outbound Bridge client | High (hanging request can wedge a worker) | **ENG-286** |
| No two-key overlap on webhook key rotation | Medium (forced downtime during rotation) | new ticket TBD |
| No append-only audit ledger | Medium (compliance / forensics) | new ticket TBD |
| Error-message overwrite loses context (see API §8.4) | Medium (forensics during incidents) | new ticket TBD |
| KYC iframe origin not pinned in mobile app | Low — Bridge controls the URL but worth documenting in mobile spec | mobile-side ticket |

## Document History

| Date | Author | Change |
|---|---|---|
| 2026-04-22 | Taddesse (Dread review) | Initial security writeup, sourced from spec branch. |
