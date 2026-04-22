# Bridge.xyz Wallet Integration

> Flash's USD on/off-ramp via Bridge.xyz. Phase 1 scope is USDT-on-Ethereum
> settlement, US bank rails (ACH), Persona-driven KYC delivered via Bridge's
> hosted iframes, and Cashout V1 for JMD off-ramp via the existing
> ERPNext-backed flow.

## Status

| Aspect | Branch | Last sync |
|---|---|---|
| Spec branch | `lnflash/flash:docs/bridge-integration-spec @ 85af420` | 2026-04-22 |
| Phase | 1 (ETH-only, US-only fiat rails for the Bridge half) | — |
| Day-one resourcing | JM available post-2026-05-15 | — |
| Workflow | Pushes to review branch `docs/bridge-integration-rewrite-2026-04-22` allowed; **no PRs and nothing to `main`** without explicit approval | — |

## Document index

| Doc | Audience | What it covers |
|---|---|---|
| **[EXECUTIVE-SUMMARY.md](./EXECUTIVE-SUMMARY.md)** | Leadership, product, finance, non-engineering | 10,000-foot view: what this is, why, current state, blockers, risk register, what it would take to ship Phase 1. Start here. |
| **[FLOWS.md](./FLOWS.md)** | Product, mobile, support | End-user flows: KYC, deposit, withdraw, the routing decision (Cashout V1 vs Bridge off-ramp), JM-no-EA fallback. Single source of truth for "what does the user see and what triggers what". |
| **[ARCHITECTURE.md](./ARCHITECTURE.md)** | Backend engineers | Service layer, webhook server, data model, external integrations, jurisdiction routing, configuration, security model, observability, open work. |
| **[WEBHOOKS.md](./WEBHOOKS.md)** | Backend engineers, ops | Bridge webhook server (port 4009), per-event handlers (`/kyc`, `/deposit`, `/transfer`), the IBEX `/crypto/receive` route, signature verification, idempotency, alert table. |
| **[API.md](./API.md)** | Mobile, integration partners | GraphQL surface (4 mutations + 4 queries), real wire-level error codes, payload-shape mismatch bugs, missing operations. |
| **[SECURITY.md](./SECURITY.md)** | Security review, ops | Inbound webhook trust, outbound API auth, secret handling, ownership/cross-account safeguards, PII boundary, KYC iframe trust model. |
| **[OPERATIONS.md](./OPERATIONS.md)** | Ops, on-call | Runbook: configuration, health checks, deploy/rollback, alert response, backfill / replay, incident playbooks. |
| **[LIMITS.md](./LIMITS.md)** | Product, support, ops | What's enforced in code today (USDT-balance check), Bridge-side limits (TBD), Flash overlay limits (TBD), decision matrix. |
| **[FEES.md](./FEES.md)** | Product, finance, support | Bridge fees (TBD per pricing), Flash markup options, FX/spread accounting, what code actually charges today (zero — `developer_fee_percent` is unused). |
| `notes.md`, `synthesis.md` | Internal | Working notes from the synthesis phase that produced these docs. Not user-facing. |

## Quick navigation by question

- **"How does a user deposit USD?"** → FLOWS §3, ARCHITECTURE §2, WEBHOOKS §4 (the IBEX `/crypto/receive` ingestion).
- **"How does a user withdraw to a US bank?"** → FLOWS §4, API §4.4, ARCHITECTURE §5, WEBHOOKS §3.3.
- **"What happens for a JM user?"** → FLOWS §0 routing, FLOWS §6 Cashout V1 path.
- **"What can go wrong with the integration today?"** → API §8, ARCHITECTURE §11, WEBHOOKS §6.
- **"How is a webhook authenticated?"** → WEBHOOKS §2, SECURITY §2.
- **"What does the database look like?"** → ARCHITECTURE §6, OPERATIONS §5.
- **"What does Bridge cost us?"** → FEES.md (mostly TBD).

## Phase 1 scope decisions (locked)

- **USDT on Ethereum** for settlement (Tron pivoted away; IBEX
  parent-account/child-address cost was prohibitive).
- **No US PII on Flash systems.** Persona/Plaid iframes load directly from
  Bridge inside the mobile app; backend never proxies PII. Existing JM PII in
  Frappe ERPNext is unchanged.
- **Iframe-embed KYC pattern.** Bridge KYC links open as iframes; backend's
  involvement ends at issuing the link.
- **Off-ramp gating is rail-driven, plus a Flash-maintained country
  allowlist.** Bridge enforces rail availability at link time as the
  authoritative second check. **Flash maintains its own country allowlist
  as a superset of Bridge's allowlist plus the Caribbean countries we
  plan to serve.** The Flash allowlist gates UI/feature visibility before
  the user ever hits Bridge so users in supported Caribbean markets see
  the Cashout/Topup entry points even when their country is not on
  Bridge's list (those routes can fall back to Cashout V1 / JMD ERPNext
  rather than Bridge). **Open work** — the country allowlist itself is
  not yet built; tracked as `NEW-COUNTRY-ALLOWLIST` (to be filed under
  Dread / Nick).
- **JMD KYC remains separate** — handled by the existing Frappe ERPNext flow,
  unchanged by this integration.
- **Cashout V1 (JMD off-ramp) does invoke the backend** — it creates a
  Cashout DocType in ERPNext + a JournalEntry; support manually triggers
  RTGS; PaymentEntry recorded; push notification via
  `adminPaymentEntryNotificationSend`. The mobile-app withdrawal router
  routes between Cashout V1 and Bridge off-ramp.

## Known open work (cross-cutting)

| Area | Linear | One-line |
|---|---|---|
| IBEX Ethereum address provisioning | **ENG-296** | Service hard-stops with "IBEX Ethereum address creation not yet implemented" — blocks every deposit. |
| Wallet-credit on `/crypto/receive` | **ENG-296** (broader) | IBEX webhook only logs today — no wallet credit, no push. |
| ToS-accept + pre-KYC profile mutation | **ENG-343** | KYC link today defaults `full_name` to `account.username` and falls back to the literal string `"Flash"` when `username` is empty — both are wrong (the `"Flash"` literal is essentially dead-code defensive fallback). ENG-343 captures the user's **real legal name + email + ToS-accept timestamp** before the link is minted. **PII boundary note:** name + email are PII Flash already holds (in Mongo / Kratos). SSN, DOB, address, ID document never touch Flash — they are entered inside the Persona iframe and stored by Bridge. **Phone-number capture + ERPNext storage is a separate product decision** (see Dread question 2026-04-22) — if adopted, it would be the first time Flash holds a US user's phone outside Kratos and crosses into US-PII-on-Flash territory. |
| Insufficient-balance / amount validation | **ENG-280** (CRIT-1) | Done in service via float parsing; precision concern. |
| Cross-account ownership for external accounts | **ENG-281** (CRIT-2) | Done at app + DB compound-index level. |
| Withdrawal idempotency | (new) | `bridgeInitiateWithdrawal` has no client idempotency key; retries duplicate transfers. |
| GraphQL payload-shape mismatch | (new — see API §8.1) | Most type fields resolve to `null` on the wire. |
| GraphQL error-code collapse | (new — see API §8.4) | All Bridge errors map to `INVALID_INPUT` or `UNKNOWN_CLIENT_ERROR`. |
| Sandbox E2E | **ENG-274** | Not yet built. |
| Validation hardening | **ENG-285** | Per-field validation. |
| Circuit breaker | **ENG-286** | Around outbound Bridge calls. |
| Monitoring + alerting | **ENG-273** | Alert table drafted in WEBHOOKS §6. |
| Push notifications on transfer events | **ENG-275** | `// TODO` in `transferHandler`. |
| Runbook | **ENG-272** | This OPERATIONS.md is the v0. |

## Conventions

- **Source-of-truth for code references** is the spec branch
  `docs/bridge-integration-spec @ 85af420`. Every claim in these docs is
  grounded in source on that ref.
- **No fictional symbols.** If a symbol/route/field is documented, it exists
  in code. If it's planned, it's labelled "TBD" or linked to a Linear ticket.
- **Pushes go to the review branch only.** This doc set lives on
  `docs/bridge-integration-rewrite-2026-04-22` for Dread's review.
  **No PRs and nothing to `main`** without explicit approval. The spec
  branch (`docs/bridge-integration-spec @ 85af420`) remains the
  source-of-truth for code references; nothing in this folder reflects
  merged code beyond that ref.

## Document History

| Date | Author | Change |
|---|---|---|
| 2026-04-22 | Taddesse (Dread review) | Initial README created as the index for the rewritten doc set. |
| 2026-04-22 | Taddesse (Dread review) | Applied Dread feedback (12:35 ET): country allowlist — Flash maintains a superset of Bridge + Caribbean countries we plan to serve (open work, ticket TBD); ENG-343 line clarified (real legal name + email + ToS, with phone/ERPNext as a flagged product decision and PII-boundary note); workflow note updated — pushes to review branch are now allowed, no PRs / no `main`. |
