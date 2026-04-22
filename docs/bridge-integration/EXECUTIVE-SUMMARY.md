# Bridge.xyz Integration — Executive Summary

> 10,000-foot view of Flash's Bridge.xyz USD on/off-ramp integration.
> Audience: leadership, product, finance, non-engineering stakeholders.
> Detail lives in the sibling docs (FLOWS, ARCHITECTURE, WEBHOOKS, API,
> SECURITY, OPERATIONS, LIMITS, FEES). Spec branch:
> `lnflash/flash:docs/bridge-integration-spec @ 85af420`.

## 1. What this integration is

Flash is adding a **USD on/off-ramp** to the wallet by integrating with
**Bridge.xyz**. In Phase 1 this means:

- **Cash Wallet swap (migration).** Flash's Cash Wallet today is an
  IBEX **USD** account. Phase 1 introduces an IBEX **ETH-USDT** account
  as the new Cash Wallet. **The IBEX ETH-USDT account IS the Flash
  Cash Wallet** — there is no separate "Flash USDT ledger" that gets
  credited alongside it. IBEX is the ledger. Users (US **and** JM)
  move to the new wallet via a **per-user, opt-in, permanent,
  non-reversible** toggle in the settings screen. Users who do not
  opt in remain on the legacy IBEX USD Cash Wallet and do not see
  any Bridge features.
- A US user (opted-in) can **fund their Cash Wallet** by sending USD
  to a Bridge-issued virtual bank account; Bridge converts USD → USDT
  and sends it on **Ethereum** to the user's IBEX ETH-USDT account.
  The Cash Wallet balance goes up because IBEX received the USDT — no
  separate Flash-side credit step.
- A US user (opted-in) can **withdraw to a US bank** via ACH; IBEX
  sends USDT from the user's ETH-USDT account to Bridge, Bridge
  converts USDT → USD and pushes it to the user's verified external
  bank account. The Cash Wallet balance goes down because IBEX sent
  the USDT out.
- **JM users** who opt in get the same ETH-USDT Cash Wallet. Per Dread
  2026-04-22 14:15 ET: on Cashout V1's re-launch, **ETH-USDT becomes
  the first-class source wallet** for the JMD off-ramp (not merely an
  alternative for opted-in users). Legacy IBEX USD is the fallback for
  non-opted-in users only. Settlement involves a USDT → USD swap via
  IBEX before the JMD leg. This is tracked on this project as
  NEW-CASHOUT-V1-WALLET (Bridge-side half) and mirrored by a spec
  update on the Cashout V1 project (opt-in decision tree) owned by
  Dread. **ENG-296 is now a cross-project launch blocker for both
  Bridge Wallet Integration and Cashout V1.**
- **Lightning parity on the new Cash Wallet** is Phase 1 scope —
  opted-in users must still be able to send/receive Lightning on day
  one. IBEX's ETH-USDT accounts support Lightning per
  `docs.ibexmercado.com/reference/welcome`; ENG-297 proves out that
  capability as a launch-blocker (not post-launch).
- **KYC** runs through Bridge's hosted Persona/Plaid iframes embedded
  in the mobile app; **no US KYC PII (SSN, DOB, address, ID) ever
  lands on Flash systems**.
- **ERPNext ledger for Bridge ↔ IBEX USDT movements.** Every USDT
  movement between Bridge and IBEX triggered by a Flash user must
  write an audit row into ERPNext. This is new Phase-1 work.

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
| **Cash Wallet model** | **IBEX ETH-USDT account IS the Cash Wallet.** IBEX is the ledger; Flash holds no parallel USDT wallet ledger. | Simplest correct design — avoids dual-bookkeeping between IBEX and Flash, eliminates the "crediting" race. |
| **Migration model** | **Per-user, opt-in, permanent, non-reversible.** Users opt in from settings; legacy IBEX USD Cash Wallet and new IBEX ETH-USDT Cash Wallet both exist on IBEX side forever; Flash UI only ever shows one Cash Wallet per user. Non-opted-in users cannot access Bridge features. | Controlled rollout without a forced migration cut-over; individual user can stay on legacy if they choose. |
| **Lightning parity on new wallet** | **Launch blocker** (ENG-297) — opted-in users must still send/receive Lightning on the ETH-USDT Cash Wallet day one. | Parity with existing Cash Wallet behavior. IBEX ETH-USDT accounts support Lightning per IBEX docs. |
| **ERPNext ledger for USDT movement** | **In scope (new work).** Every Bridge ↔ IBEX USDT movement for a Flash user writes an audit row to ERPNext. | Finance/accounting requirement for USDT flowing between two vendors under Flash users' names. |
| Fiat rails | **US ACH** (off-ramp) and Bridge virtual accounts (on-ramp) | Wire deferred. |
| KYC delivery | **Bridge-hosted iframes** (Persona/Plaid) | Keeps US PII off Flash entirely. |
| Country gating | **Flash-maintained allowlist (superset of Bridge + Caribbean markets) PLUS Bridge's rail-driven check.** | Flash allowlist gates UI entry; Bridge's link-time check remains the authoritative rail gate. |
| JMD KYC | **Frappe ERPNext (existing flow)** unchanged | JMD KYC stays separate from Bridge KYC. |
| JMD off-ramp | **Cashout V1 (ERPNext, manual RTGS) — ETH-USDT becomes the first-class source wallet on re-launch.** | Confirmed Dread 2026-04-22 14:15 ET. Default source is ETH-USDT for opted-in users (with USDT→USD swap via IBEX); legacy IBEX USD only for non-opted-in fallback. Tracked as **NEW-CASHOUT-V1-WALLET**. **ENG-296 is a cross-project blocker** — it gates both this project and Cashout V1. |
| Workflow | Pushes to review branch **`docs/bridge-integration-rewrite-2026-04-22`** allowed; **no PRs and nothing to `main`** without explicit approval. | Review material; live branch. |

## 4. Current implementation state

### What works in code today

- Service layer (`BridgeService`) for KYC link creation, virtual
  account creation, external account linking, withdrawal initiation,
  and four read queries.
  > **No separate "payment route" creation step.** Bridge's model is
  > VA (inbound rail) + EA (outbound destination) + **Transfer** (the
  > money movement). `BridgeService.initiateWithdrawal` is what calls
  > Bridge's `/transfers` endpoint — that single call is the route +
  > the execution. Routing per se is implicit in `(source = VA's
  > rail/USDT-on-ETH, destination = EA's rail/ACH-USD)` at the moment
  > the transfer is initiated.
- Webhook server on port 4009 with three handlers (`/kyc`,
  `/deposit`, `/transfer`) using **RSA-SHA256 signature verification**
  with a 5-minute timestamp skew window.
  > **There is no `/withdraw` endpoint.** Bridge names the off-ramp
  > lifecycle "transfer" (because the bank-side leg is a USD wire /
  > ACH transfer). The Flash UI surfaces the same lifecycle as
  > **Transfer → Cashout (Withdraw)** for off-ramp and
  > **Transfer → Topup (Deposit)** for on-ramp. The mapping is:
  > Flash Cashout/Withdraw ⇄ Bridge `/transfer` webhook events
  > (`transfer.created` / `.updated` / `.completed` / `.failed`);
  > Flash Topup/Deposit ⇄ Bridge `/deposit` webhook events **plus**
  > the IBEX `/crypto/receive` notification. **Neither webhook
  > "credits a Flash wallet" — IBEX's ETH-USDT account IS the Cash
  > Wallet, so the balance moves the moment IBEX sees the USDT. The
  > Flash-side work on `/crypto/receive` is (a) an ERPNext audit row
  > and (b) a user-facing push notification.**
- IBEX `/crypto/receive` route on the main API for inbound USDT
  notifications (today: log-only; planned: ERPNext audit entry + push,
  see ENG-275 and NEW-ERPNEXT-LEDGER).
- Mongo schema for virtual accounts, external accounts, and
  withdrawals, with a **compound unique index** preventing a user from
  funding a withdrawal through someone else's bank account
  (CRIT-2 / ENG-281, fixed).
- USDT balance check before withdrawal (CRIT-1 / ENG-280, fixed) —
  reads the **IBEX ETH-USDT account balance** (the Cash Wallet),
  not a separate Flash ledger.
- Account-level ≥ 2 (Pro) gate on every Bridge operation.
- GraphQL surface: 4 mutations + 4 queries.

### What does **not** work yet (blockers)

| Gap | Linear | Impact |
|---|---|---|
| **IBEX ETH-USDT wallet provisioning is a hard-stop** ("not yet implemented") | **ENG-296** | Blocks every deposit. The opt-in flow cannot mint a Cash Wallet on the new rail until this lands. |
| **Lightning send/receive parity on the ETH-USDT wallet** (IBEX supports it per docs, but Flash surface not wired) | **ENG-297** — now a **Phase-1 launch blocker** | Without LN parity, opted-in users lose existing Cash Wallet capabilities — unacceptable for launch. |
| **Per-user opt-in toggle** (settings screen; permanent, non-reversible; gates Bridge features; Flash UI shows one Cash Wallet) | **NEW-OPTIN** (to file; Nick/Ben) | No way for a user to switch to the new Cash Wallet model. Blocks every user-visible Bridge feature. |
| **ERPNext audit ledger for Bridge ↔ IBEX USDT movements** | **NEW-ERPNEXT-LEDGER** (to file; Olaniran or Dread) | Finance/accounting requirement; a USDT flow between two vendors under a Flash user's name must be reconcilable. |
| **Cashout V1 — ETH-USDT as first-class source wallet on re-launch** (default for opted-in users, with USDT→USD swap before JMD off-ramp; legacy USD fallback only for non-opted-in users). Confirmed Dread 2026-04-22 14:15 ET. | **NEW-CASHOUT-V1-WALLET** (to file on this project, Olaniran+Ben) + Cashout V1 project spec update (owned by Dread) | Cashout V1 cannot launch with ETH-USDT as a first-class wallet without this. **ENG-296 blocks both projects.** |
| **Country allowlist** (Flash-maintained superset of Bridge's allowlist + Caribbean markets we plan to serve) | **NEW-COUNTRY-ALLOWLIST** (to file; Dread/Nick) | Without it, UI entry gating relies on Bridge's list alone, which does not include the Caribbean markets where we want Cashout V1 to appear. |
| **GraphQL payload-shape mismatches** across all 4 mutations + 4 queries | (new) | Most response fields resolve to `null` on the wire. App relies on side-channel queries. |
| **All Bridge errors collapse to `INVALID_INPUT` or `UNKNOWN_CLIENT_ERROR`** | (new) | App cannot distinguish "rate limited", "KYC pending", "account suspended" — all look the same. |
| **No client idempotency key** on `bridgeInitiateWithdrawal` | (new) | A retry can duplicate a transfer. |
| **No refund on `transfer.failed`** | (new) | A failed off-ramp leaves the wallet debited on the IBEX ledger with no compensating credit. |
| **No push notifications** on transfer / deposit events | ENG-275 | User has no signal a withdrawal completed or a deposit landed. |
| **No outbound retry / circuit breaker** to Bridge | ENG-286 | Transient Bridge 5xx surface as user-facing failures. |
| **No sandbox E2E** | ENG-274 | Confidence in changes is low. |
| **Pre-KYC profile mutation** (real legal name + email + ToS accept) | ENG-343 | Today the KYC link is created with `full_name = account.username` and a `"Flash"` literal dead-code fallback. Real legal name + email + ToS timestamp must be captured first. |
| **IBEX auth deprecation deadline — May 31, 2026** (external, cross-cutting) | ENG-38 | Bridge depends on IBEX for the crypto leg. If Flash has not migrated to IBEX's new M2M client-credentials auth by May 31, the rail breaks on that date. Tracked outside the Bridge project; **Ben owns it, due 2026-05-31, Urgent**. |

### What's intentionally out of scope (Phase 1)

- Wire transfers, SEPA, non-US rails.
- Non-Ethereum settlement.
- USD-denominated balance UX (USD lands as USDT in the wallet).
- KYC tier-upgrade flows beyond Bridge's default.
- Flash-side fee collection (see §6).

## 5. Architecture in one paragraph

The mobile app calls Flash's GraphQL API for the opt-in toggle, KYC
link issuance, virtual-account creation, external-account linking
(returns a Bridge-hosted link the user opens), and withdrawal
initiation. Flash's `BridgeService` calls Bridge's REST API with
`Api-Key` auth. Bridge calls back over webhooks
(`/kyc`, `/deposit`, `/transfer`) on port 4009; signatures are
verified with per-endpoint RSA public keys. IBEX calls Flash's main
API at `/crypto/receive` to notify of inbound USDT. **The IBEX
ETH-USDT account IS the user's Cash Wallet**, so the balance moves on
IBEX's side — Flash does not run a parallel wallet ledger. A Mongo
schema persists Bridge customer IDs, virtual accounts, external
accounts, withdrawals, and the opt-in flag. An ERPNext audit row is
written for every Bridge ↔ IBEX USDT movement. **No US KYC PII** is
stored on Flash — only the Bridge customer ID, KYC status enum, and
bank-account metadata Bridge already returns (bank name, last-4). The
user's real legal name + email + ToS timestamp (captured pre-KYC via
ENG-343) are PII Flash already holds in Mongo / Kratos.

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

In rough order (launch waves):

1. **ENG-296** — IBEX ETH-USDT wallet provisioning. **Without this,
   there is no new Cash Wallet to opt users into. Also a cross-project
   launch blocker for Cashout V1** (Dread 2026-04-22 14:15 ET).
2. **ENG-297** — Lightning send/receive parity on the ETH-USDT wallet.
   **Launch blocker**; opted-in users must retain LN capability.
3. **NEW-OPTIN** — per-user opt-in toggle (settings screen; permanent,
   non-reversible; gates every Bridge feature; Flash UI shows one
   Cash Wallet).
4. **NEW-ERPNEXT-LEDGER** — ERPNext audit-row writer for every
   Bridge ↔ IBEX USDT movement under a Flash user's name.
5. **NEW-CASHOUT-V1-WALLET** — Cashout V1: ETH-USDT as the first-class
   source wallet on re-launch (with USDT→USD swap before JMD off-ramp);
   legacy USD fallback only for non-opted-in users. Mirrors a Cashout
   V1 project spec update owned by Dread.
6. **NEW-COUNTRY-ALLOWLIST** — Flash-maintained country allowlist
   (superset of Bridge + Caribbean markets) gating UI entry.
7. **ENG-343** — Pre-KYC profile capture (real legal name + email +
   ToS timestamp) so the KYC link is created correctly.
8. **GraphQL payload-shape fixes** + **error-code differentiation**
   (the two new tickets in §4) — so the mobile app can show useful
   states.
9. **Withdrawal idempotency key** — prevents duplicate transfers on
   retry.
10. **Refund on `transfer.failed`** — prevents wallet leakage on
    off-ramp failure.
11. **Push notifications** (ENG-275) — transfer + deposit lifecycle
    visibility (driven from `/crypto/receive` for deposits and
    `/transfer` for off-ramp).
12. **Bridge contract pinned** — fees, limits, rate limits — feeding
    into LIMITS.md and FEES.md follow-ups.
13. **Sandbox E2E** (ENG-274) and **circuit breaker** (ENG-286) —
    resilience for real-world Bridge behavior.
14. **Monitoring + alerting wiring** (ENG-273) — so on-call can
    actually respond.
15. **IBEX auth migration** (ENG-38, Ben, due 2026-05-31) — external
    dependency; Bridge rail dies on that date if not done.
16. **Runbook drilled** (ENG-272) — this doc set is v0; first incident
    rehearsal validates it.

## 11. Risk register (top 5)

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | Deposit pipeline ships without ENG-296 fully wired → IBEX has no ETH-USDT account for the user → Bridge sends USDT to an address that doesn't exist, or the user has no Cash Wallet to receive it | Medium | High (stuck funds + support load) | Hard-block release on ENG-296 + IBEX webhook end-to-end test. |
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
| 2026-04-22 | Taddesse (Dread review) | §4 clarifications per Dread questions (12:35 ET): (a) no separate "payment route" creation — Bridge's model is VA + EA + Transfer, and `initiateWithdrawal` is the single call to `/transfers`; (b) no `/withdraw` webhook — Bridge calls the off-ramp lifecycle "transfer" and the Flash UI maps it as "Transfer → Cashout (Withdraw)" / "Transfer → Topup (Deposit)". |
| 2026-04-22 | Taddesse (Dread review) | **Architectural correction (13:09 ET):** IBEX ETH-USDT account IS the Flash Cash Wallet; there is no separate Flash-side wallet ledger being credited. Introduced per-user permanent opt-in migration model (legacy IBEX USD → IBEX ETH-USDT). ENG-297 (LN parity on new wallet) moved from post-launch to **Phase-1 launch blocker**. Filed new tickets: NEW-OPTIN, NEW-ERPNEXT-LEDGER, NEW-CASHOUT-V1-WALLET, NEW-COUNTRY-ALLOWLIST. JM users are included in the migration; cash-in for an opted-in JM user lands as USDT in their IBEX ETH-USDT account, which changes the source wallet for Cashout V1. §1, §3, §4, §5, §10, §11 rewritten. |
