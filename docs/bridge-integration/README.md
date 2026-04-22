# Bridge.xyz Wallet Integration

> Flash's USD on/off-ramp via Bridge.xyz. Phase 1 scope is **a Cash Wallet
> swap from the legacy IBEX USD account to an IBEX ETH-USDT account**
> (IBEX is the ledger; the IBEX ETH-USDT account IS the Cash Wallet),
> opt-in per user and permanent, USDT-on-Ethereum settlement, US bank
> rails (ACH), Persona-driven KYC delivered via Bridge's hosted iframes,
> Lightning parity on the new wallet (ENG-297), and Cashout V1 for JMD
> off-ramp via the existing ERPNext-backed flow (with source-wallet
> change for opted-in JM users).

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
- **IBEX ETH-USDT account IS the Flash Cash Wallet.** IBEX is the
  ledger. There is no Flash-side parallel USDT ledger being credited.
  On-ramp = USDT lands in the user's IBEX ETH-USDT account (balance
  goes up on IBEX side). Off-ramp = IBEX sends USDT from the user's
  ETH-USDT account to Bridge (balance goes down on IBEX side).
- **Per-user opt-in Cash Wallet migration, permanent and
  non-reversible.** On IBEX side, both the legacy IBEX USD account and
  the new IBEX ETH-USDT account exist for the foreseeable future. In
  Flash UI, a user ever sees only one Cash Wallet. Users opt in from
  the settings screen post app-update. Non-opted-in users keep the
  legacy wallet and cannot access any Bridge features. Opt-in is a
  one-way flip — a user cannot roll back.
- **Lightning send/receive parity on the new wallet (ENG-297)** is a
  **Phase-1 launch blocker**, not post-launch. IBEX ETH-USDT accounts
  support Lightning per
  <https://docs.ibexmercado.com/reference/welcome>.
- **ERPNext ledger for every Bridge ↔ IBEX USDT movement.** New
  Phase-1 work (NEW-ERPNEXT-LEDGER). Writes an audit row per on-ramp
  and off-ramp leg for accounting/reconciliation.
- **JM users opt in too.** Their cash-in lands as USDT in the IBEX
  ETH-USDT account. Per Dread 2026-04-22 14:15 ET: on **Cashout V1's
  re-launch**, ETH-USDT is the **first-class source wallet** for the
  JMD off-ramp (default path; includes a USDT→USD swap via IBEX
  before the JMD leg); legacy IBEX USD is the fallback for
  non-opted-in users only. This is tracked on this project as
  NEW-CASHOUT-V1-WALLET (Bridge-side half) and mirrored by a spec
  update on the Cashout V1 project (opt-in decision tree + source-wallet
  selection) owned by Dread. **ENG-296 is now a cross-project launch
  blocker for both Bridge Wallet Integration and Cashout V1.**
- **No US KYC PII on Flash systems.** Persona/Plaid iframes load
  directly from Bridge inside the mobile app; backend never proxies
  PII. SSN, DOB, address, ID document stay with Bridge/Persona. Name
  + email (captured pre-KYC per ENG-343) are PII Flash already holds
  in Mongo / Kratos. Existing JM PII in Frappe ERPNext is unchanged.
- **Iframe-embed KYC pattern.** Bridge KYC links open as iframes;
  backend's involvement ends at issuing the link.
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
| IBEX ETH-USDT wallet provisioning | **ENG-296** | Service hard-stops with "IBEX Ethereum address creation not yet implemented" — blocks the whole migration (no new Cash Wallet to opt users into). **Also a launch blocker for the Cashout V1 project** (Dread 2026-04-22 14:15 ET) — ETH-USDT is its first-class source wallet on re-launch. |
| Lightning send/receive parity on ETH-USDT wallet | **ENG-297** (promoted to **Phase-1 launch blocker**) | IBEX docs confirm LN send/receive on ETH-USDT accounts; Flash surface must match existing legacy-wallet LN capability or opt-in users regress. |
| Per-user opt-in toggle (settings screen; permanent; gates Bridge features) | **NEW-OPTIN** (to file — Nick/Ben) | No way to switch to the new Cash Wallet today; every Bridge feature depends on this. |
| ERPNext audit ledger for Bridge ↔ IBEX USDT movements | **NEW-ERPNEXT-LEDGER** (to file — **Ben**, reassigned 15:52 ET) | Finance/accounting requirement; audit every on-ramp + off-ramp leg. Consolidated with the webhook handlers Ben already owns after the 15:36 ET IBEX handoff. Dread remains the ERPNext contract counterpart. |
| Cashout V1: ETH-USDT as the first-class source wallet on re-launch (USDT→USD swap before JMD off-ramp); legacy USD fallback only for non-opted-in users | **NEW-CASHOUT-V1-WALLET** (to file — Olaniran+Ben on this project) + Cashout V1 project spec update (Dread) | Confirmed Dread 2026-04-22 14:15 ET. Cashout V1 cannot launch with ETH-USDT as a first-class wallet without the Bridge-side half here AND the Cashout V1 project's own spec update. |
| `/crypto/receive` follow-ups | **ENG-275** (push) + **NEW-ERPNEXT-LEDGER** (audit) | IBEX webhook today only logs; no push notification, no ERPNext audit row. (Previously listed as "wallet credit" — that framing was wrong; IBEX owns the wallet balance.) |
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
| 2026-04-22 | Taddesse (Dread review) | **Architectural correction (13:09 ET):** top-of-file blurb rewritten; Phase 1 scope rewritten with IBEX ETH-USDT = Cash Wallet, per-user opt-in migration, Lightning parity as launch blocker, ERPNext USDT-movement ledger, and JM inclusion (with Cashout V1 source-wallet implication); open-work table replaced "wallet credit" row with IBEX-is-the-ledger framing and added NEW-OPTIN, ENG-297 promotion, NEW-ERPNEXT-LEDGER, NEW-CASHOUT-V1-WALLET. |
| 2026-04-22 15:52 ET | Taddesse (Dread directive) | **NEW-ERPNEXT-LEDGER reassigned to Ben.** Per Dread: the ERPNext audit-row writer belongs on Ben rather than Olaniran (or Dread as relief). Rationale: the audit writer sits on top of the `/crypto/receive` + `/deposit` + `/transfer` webhook paths Ben now owns after the 15:36 ET IBEX handoff — consolidating the audit writer with the handlers that emit the USDT-movement events avoids cross-engineer handoffs at the ticket boundary. README change: open-work table row updated from "Olaniran or Dread" to "Ben (reassigned 15:52 ET)" with a note that Dread remains the ERPNext contract counterpart. |
| 2026-04-22 | Taddesse (Dread confirmation) | **Cashout V1 follow-up (14:15 ET):** Cashout V1's source wallet flips. Reframed §"Phase 1 scope decisions" Cashout V1 bullet from "must learn to source from ETH-USDT for opted-in users" to **"ETH-USDT is the first-class source wallet on Cashout V1 re-launch"** (legacy USD = fallback for non-opted-in users only). ENG-296 row + NEW-CASHOUT-V1-WALLET row in open-work table updated to call out **ENG-296 is now a cross-project launch blocker for Cashout V1 as well**. |
