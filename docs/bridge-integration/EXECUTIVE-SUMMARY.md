# Bridge.xyz Integration — Executive Summary

> 10,000-foot view of Flash's Bridge.xyz USD on/off-ramp integration.
> Audience: leadership, product, finance, non-engineering stakeholders.
> Detail lives in the sibling docs (FLOWS, ARCHITECTURE, WEBHOOKS, API,
> SECURITY, OPERATIONS, LIMITS, FEES). Spec branch:
> `lnflash/flash:docs/bridge-integration-spec @ 85af420`.

## 1. What this integration is

Flash is adding a **USD on/off-ramp** to the wallet by integrating with
**Bridge.xyz**. In Phase 1 this means:

- A US user can **fund a Flash USDT balance** by sending USD to a
  Bridge-issued virtual bank account; Bridge converts USD → USDT and
  settles it on **Ethereum** to an IBEX-controlled address; the wallet
  is credited.
- A US user can **withdraw to a US bank** via ACH; Flash debits their
  USDT balance, instructs Bridge to convert USDT → USD and push it to
  the user's verified external bank account.
- **KYC** runs through Bridge's hosted Persona/Plaid iframes embedded
  in the mobile app; **no US PII ever lands on Flash systems**.
- **JM users** continue to use the existing ERPNext-backed Cashout V1
  for JMD off-ramp, unchanged. The mobile app routes between Cashout V1
  and Bridge based on the destination rail.

## 2. Why we're doing it

- **Unlocks USD rails** for Flash wallet users without Flash itself
  becoming a money transmitter for USD. Bridge is the regulated party.
- **Keeps PII off Flash.** US KYC liability stays with Bridge/Persona;
  Flash holds only the Bridge customer ID and a status enum.
- **Reuses IBEX** for the crypto leg — no new custody primitive.
- **Path to broader USD products** (savings, payroll, cards) once the
  rail is proven.

## 3. Phase 1 scope (locked)

| Decision | Choice | Why |
|---|---|---|
| Settlement chain | **USDT-on-Ethereum** | Tron pivoted away; IBEX parent-account / child-address pricing on alternatives was prohibitive. |
| Fiat rails | **US ACH** (off-ramp) and Bridge virtual accounts (on-ramp) | Wire deferred. |
| KYC delivery | **Bridge-hosted iframes** (Persona/Plaid) | Keeps US PII off Flash entirely. |
| Country gating | **Rail-driven, not country-driven** | Bridge enforces availability at link-creation time. |
| JMD off-ramp | **Cashout V1 (ERPNext, manual RTGS)** unchanged | Out of scope for the Bridge half. |
| Workflow | Drafts only — **no pushes / no PRs without approval** | This doc set is review material. |

## 4. Current implementation state

### What works in code today

- Service layer (`BridgeService`) for KYC link creation, virtual
  account creation, external account linking, withdrawal initiation,
  and four read queries.
- Webhook server on port 4009 with three handlers (`/kyc`,
  `/deposit`, `/transfer`) using **RSA-SHA256 signature verification**
  with a 5-minute timestamp skew window.
- IBEX `/crypto/receive` route on the main API for inbound USDT
  notifications.
- Mongo schema for virtual accounts, external accounts, and
  withdrawals, with a **compound unique index** preventing a user from
  funding a withdrawal through someone else's bank account
  (CRIT-2 / ENG-281, fixed).
- USDT balance check before withdrawal (CRIT-1 / ENG-280, fixed).
- Account-level ≥ 2 (Pro) gate on every Bridge operation.
- GraphQL surface: 4 mutations + 4 queries.

### What does **not** work yet (blockers)

| Gap | Linear | Impact |
|---|---|---|
| **IBEX Ethereum address provisioning is a hard-stop** ("not yet implemented") | **ENG-296** | Blocks every deposit. No US user can fund a wallet today. |
| **Wallet credit on `/crypto/receive` is just a log line** | ENG-296 (broader) | Even if deposits arrived, the wallet would not be credited. |
| **GraphQL payload-shape mismatches** across all 4 mutations + 4 queries | (new) | Most response fields resolve to `null` on the wire. App relies on side-channel queries. |
| **All Bridge errors collapse to `INVALID_INPUT` or `UNKNOWN_CLIENT_ERROR`** | (new) | App cannot distinguish "rate limited", "KYC pending", "account suspended" — all look the same. |
| **No client idempotency key** on `bridgeInitiateWithdrawal` | (new) | A retry can duplicate a transfer. |
| **No refund on `transfer.failed`** | (new) | A failed off-ramp leaves the wallet debited. |
| **No push notifications** on transfer events | ENG-275 | User has no signal a withdrawal completed. |
| **No outbound retry / circuit breaker** to Bridge | ENG-286 | Transient Bridge 5xx surface as user-facing failures. |
| **No sandbox E2E** | ENG-274 | Confidence in changes is low. |
| **Pre-KYC profile mutation** (real name, ToS accept) | ENG-343 | KYC link is created with `full_name = username \|\| "Flash"`. |
| **IBEX auth deprecation deadline — May 31, 2026** (external, cross-cutting) | ENG-38 | Bridge depends on IBEX for the crypto leg. If Flash has not migrated to IBEX's new M2M client-credentials auth by May 31, the rail breaks on that date. Tracked outside the Bridge project; **Ben owns it, due 2026-05-31, Urgent**. |

### What's intentionally out of scope (Phase 1)

- Wire transfers, SEPA, non-US rails.
- Non-Ethereum settlement.
- USD-denominated balance UX (USD lands as USDT in the wallet).
- KYC tier-upgrade flows beyond Bridge's default.
- Flash-side fee collection (see §6).

## 5. Architecture in one paragraph

The mobile app calls Flash's GraphQL API for KYC link issuance,
virtual-account creation, external-account linking (returns a Bridge
hosted link the user opens), and withdrawal initiation. Flash's
`BridgeService` calls Bridge's REST API with `Api-Key` auth. Bridge
calls back over webhooks (`/kyc`, `/deposit`, `/transfer`) on port
4009; signatures are verified with per-endpoint RSA public keys. IBEX
calls Flash's main API at `/crypto/receive` to notify of inbound USDT.
A Mongo schema persists Bridge customer IDs, virtual accounts, external
accounts, and withdrawals. **No US PII** is stored — only the Bridge
customer ID, KYC status enum, and bank-account metadata Bridge already
returns (bank name, last-4).

## 6. Money & fees today

- **Flash charges nothing** on Bridge transactions today. The Bridge
  client *supports* a `developer_fee` markup but the service never
  populates it.
- **Bridge's own fees are TBD** — pending commercial contract.
- **No FX rate is captured** on the withdrawal record. There is no
  per-transaction P&L view. Adding `fee` / `fxRate` columns to the
  withdrawal schema is a prerequisite to any meaningful finance
  reconciliation.
- **No quote / confirmation UX** shows Bridge's deduction to the user.
  Even with zero Flash markup, the bank will receive less than the
  user requested — this is a product gap, not just an engineering one.

Detail in **FEES.md**.

## 7. Limits today

- **In code:** account level ≥ 2, KYC approved, external account
  verified, USDT balance ≥ amount, webhook timestamp within 5 minutes.
- **Not in code:** per-account daily/monthly caps, min-withdrawal
  floor, velocity limits, link-to-first-withdrawal cooldown,
  max-external-accounts. **All TBD pending product sign-off.**
- **Bridge-enforced limits** (per-customer tiers, per-rail min/max,
  per-API rate limits) are TBD pending Bridge contract.

Detail in **LIMITS.md**.

## 8. Security posture

- US PII never touches Flash systems (iframe model).
- Webhook signatures verified, timestamp skew bounded, idempotency
  locks held at the request level.
- Cross-account funding blocked at both app layer and DB compound
  index (CRIT-2 fix).
- Outbound API key stored in YAML config (not env, not vault) —
  **rotation is a manual deploy** and there is no scheduled rotation
  policy. Open work.

Detail in **SECURITY.md**.

## 9. Operational readiness

- **Runbook (OPERATIONS.md)** drafted — v0.
- **Alert table** drafted across 7 webhook / API failure modes
  (ENG-273 to wire to PagerDuty).
- **No deployment manifests in this repo** (charts repo lives
  elsewhere). Rollback procedure pending confirmation of where the
  Bridge feature flag is toggled in production.
- **No backfill / replay tooling** for missed webhooks. Manual Mongo
  + Bridge-API reconciliation is the only path today.

Detail in **OPERATIONS.md**.

## 10. What it would take to ship Phase 1

In rough order:

1. **ENG-296** — IBEX Ethereum address provisioning + wallet credit on
   `/crypto/receive`. **Without this, no deposits work.**
2. **ENG-343** — Pre-KYC profile capture so the KYC link is created
   with the user's real name, not their username.
3. **GraphQL payload-shape fixes** + **error-code differentiation**
   (the two new tickets in §4) — so the mobile app can show useful
   states.
4. **Withdrawal idempotency key** — prevents duplicate transfers on
   retry.
5. **Refund on `transfer.failed`** — prevents wallet leakage on
   off-ramp failure.
6. **Push notifications** (ENG-275) — transfer lifecycle visibility.
7. **Bridge contract pinned** — fees, limits, rate limits — feeding
   into LIMITS.md and FEES.md follow-ups.
8. **Sandbox E2E** (ENG-274) and **circuit breaker** (ENG-286) —
   resilience for real-world Bridge behavior.
9. **Monitoring + alerting wiring** (ENG-273) — so on-call can
   actually respond.
10. **Runbook drilled** (ENG-272) — this doc set is v0; first incident
    rehearsal validates it.

## 11. Risk register (top 5)

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | Deposit pipeline ships without ENG-296 fully wired → user funds arrive but wallet not credited | Medium | High (financial loss + support load) | Hard-block release on ENG-296 + IBEX webhook end-to-end test. |
| 2 | Withdrawal retried by user → two transfers sent → double debit | Medium | High | Add idempotency key (open ticket). |
| 3 | `transfer.failed` leaves wallet debited with no refund | Medium | High | Implement refund handler. |
| 4 | Bridge API key leaks (config-file storage, no rotation policy) | Low | Critical | Move to vault + rotation policy (open SECURITY work). |
| 5 | KYC link issued with wrong name → Bridge rejects → user stuck | High | Medium | ENG-343 pre-KYC profile. |
| 6 | **IBEX auth deprecation (May 31, 2026)** cuts the crypto rail on that date if Flash has not migrated to IBEX's new M2M client-credentials auth. Bridge depends on IBEX, so this is a hard external deadline. | Medium | Critical | **ENG-38**, owned by Ben, Urgent, due 2026-05-31. Tracked outside the Bridge project; Dread coordinates cross-project visibility. |

## 12. Document map

| Doc | One-line |
|---|---|
| **FLOWS.md** | What the user sees end-to-end, including the JM/US routing decision. |
| **ARCHITECTURE.md** | Service / webhook / data layers; what calls what. |
| **WEBHOOKS.md** | Bridge + IBEX inbound surfaces, signature verification, alert table. |
| **API.md** | GraphQL surface with real wire codes and the bug classes. |
| **SECURITY.md** | Trust boundaries, secret handling, PII posture. |
| **OPERATIONS.md** | Runbook v0: config, deploy, alerts, incident playbooks. |
| **LIMITS.md** | What's enforced today vs Bridge vs proposed Flash overlay. |
| **FEES.md** | Bridge fees (TBD), Flash markup options, what code charges (zero). |

## Document History

| Date | Author | Change |
|---|---|---|
| 2026-04-22 | Taddesse (Dread review) | Initial executive summary, written after the 8 detail docs to land at a 10,000-foot view. |
