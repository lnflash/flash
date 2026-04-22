# Bridge Wallet Integration — Linear Project Plan

> Working plan to restructure the Bridge Wallet Integration project in
> Linear, organized by **role and assignee**. Reflects the rewritten
> doc set and reconciled against the live Linear state per
> `LINEAR-VS-PROPOSAL.md`.
>
> **Source for every claim** is the spec branch
> `lnflash/flash:docs/bridge-integration-spec @ 85af420`.
>
> **Status (2026-04-22 18:30 ET, cascade #8):** ✅ Mirrored to Linear.
> All 16 new tickets filed, 3 sub-issues created, 12 blocks relations
> set, owners + priorities + descriptions reconciled, project
> description updated. The `NEW-*` placeholders that appeared in earlier
> drafts have been rewritten to live ENG IDs throughout the doc as of
> cascade #9 (18:45 ET). The historical placeholder map below is kept
> only as a Rosetta stone for old PRs / standup notes that referenced
> the placeholders before the rename.

## Historical placeholder map (cascade #8 → cascade #9)

Placeholder names used in this doc set before cascade #9 (2026-04-22
18:45 ET) → live Linear IDs filed in cascade #8. The placeholders are
no longer used inline; this table exists only so older PR / standup
references remain decodable.

| Placeholder | Linear ID | Title (truncated) |
|---|---|---|
| `NEW-OPTIN` (server half) | **[ENG-345](https://linear.app/island-bitcoin/issue/ENG-345)** | Per-user Cash Wallet opt-in flag + state machine + GraphQL mutation (server) |
| `NEW-OPTIN` (mobile half) | **[ENG-346](https://linear.app/island-bitcoin/issue/ENG-346)** | Cash Wallet opt-in CTA screen + permanence-emphasizing confirmation modal |
| `NEW-COUNTRY-ALLOWLIST` | **[ENG-347](https://linear.app/island-bitcoin/issue/ENG-347)** | Flash-maintained country allowlist (superset of Bridge's 86) |
| `NEW-ERPNEXT-LEDGER` | **[ENG-348](https://linear.app/island-bitcoin/issue/ENG-348)** | ERPNext audit-row writer for every Bridge↔IBEX USDT movement |
| `NEW-3` | **[ENG-349](https://linear.app/island-bitcoin/issue/ENG-349)** | Withdrawal idempotency key on bridgeInitiateWithdrawal |
| `NEW-4` | **[ENG-350](https://linear.app/island-bitcoin/issue/ENG-350)** | Pending-withdrawal state reset on transfer.failed |
| `NEW-1` (gql, lead) | **[ENG-351](https://linear.app/island-bitcoin/issue/ENG-351)** | GraphQL types & resolvers payload-shape fix (gql half) |
| `NEW-1` (svc) | **[ENG-352](https://linear.app/island-bitcoin/issue/ENG-352)** | Bridge service return shapes match GraphQL types (svc half) |
| `NEW-2` | **[ENG-353](https://linear.app/island-bitcoin/issue/ENG-353)** | GraphQL error-code differentiation for Bridge errors |
| `NEW-6` | **[ENG-354](https://linear.app/island-bitcoin/issue/ENG-354)** | Distinct error for KYC tier ceiling (both halves) |
| `NEW-7` | **[ENG-355](https://linear.app/island-bitcoin/issue/ENG-355)** | Min-withdrawal floor enforcement |
| `FEE-1` | **[ENG-356](https://linear.app/island-bitcoin/issue/ENG-356)** | Implement 2% developer_fee_percent on Bridge transfers |
| `NEW-CASHOUT-V1-WALLET` | **[ENG-357](https://linear.app/island-bitcoin/issue/ENG-357)** | Cashout V1 source-wallet selection logic |
| `NEW-8` | **[ENG-358](https://linear.app/island-bitcoin/issue/ENG-358)** | Add fee/developerFee/fxRate/quoteRate columns to bridgeWithdrawals |
| `NEW-10` | **[ENG-359](https://linear.app/island-bitcoin/issue/ENG-359)** | Move Bridge API key from YAML config to vault |
| `NEW-11` | **[ENG-360](https://linear.app/island-bitcoin/issue/ENG-360)** | Webhook public-key rotation policy + automation |
| `ENG-273a` (placeholder) | **[ENG-361](https://linear.app/island-bitcoin/issue/ENG-361)** | Wire Bridge alerts to PagerDuty / Slack (sub-issue of ENG-273) |
| `ENG-273b` (placeholder) | **[ENG-362](https://linear.app/island-bitcoin/issue/ENG-362)** | Bridge dashboards + ERPNext-audit-failure panel (sub-issue of ENG-273) |
| `NEW-13` | **[ENG-363](https://linear.app/island-bitcoin/issue/ENG-363)** | Enforce one-VA-per-account at Mongoose schema level (sub-issue of ENG-284) |

These placeholders no longer appear in the body below — cascade #9
rewrote them all to live ENG IDs. Use this table to decode placeholder
references in earlier PRs / standup notes / git history.

## Team

| Role | Owner | Scope |
|---|---|---|
| **Project Lead** | **Dread** | Project management, review, testing coordination, deployment, ops/runbook ownership, commercial decisions. Can pick up tasks from any area. |
| **Integration Developer** | **Olaniran** | Bridge service (`src/services/bridge/*`), `BridgeClient`, webhook server (`webhook-server/*`), Bridge ↔ IBEX integration, outbound API hardening. |
| **Flash Application Developer** | **Ben** | GraphQL surface (types/resolvers/error mapping), Mongoose schemas + migrations, Kratos integration, wallet/ledger touchpoints, account/feature-flag plumbing. |
| **Mobile App / UI Developer** | **Nick** | Mobile app screens, KYC iframe webview, deposit/withdraw UI, push-notification client config, region routing, quote/confirmation UX. |

Cross-cutting:
- **Security audit (ENG-279)** child tickets touch Olaniran's code but Dread reviews + ships.
- **Push notifications (ENG-275)** are server-triggered (**Ben** as of 2026-04-22 15:36 ET — moved off Olaniran) and client-displayed (Nick) — joint with Ben as ticket lead.
- **GraphQL bugs (ENG-351/352, ENG-353)** span the Bridge service return shapes (Olaniran) and the GraphQL types/resolvers/error map (Ben) — joint, with Ben as ticket lead.
- **Olaniran load reduction (Dread 2026-04-22 15:36 ET + 15:52 ET follow-up):** the IBEX+Flash backend critical path is moved off Olaniran. **ENG-296** and **ENG-297** are reassigned to **Ben** (IBEX integration + LN parity), **ENG-357** is reassigned to **Dread + Ben** (Dread coordinates the source-wallet selection logic; Ben keeps the account-flag GraphQL half), **ENG-275 server half** is reassigned to **Ben**, and — per Dread 15:52 ET — **ENG-348** is reassigned to **Ben** as well (the ERPNext audit writer sits on top of the `/crypto/receive` + `/deposit` + `/transfer` webhook paths Ben now owns; consolidating the audit writer with the handlers avoids cross-engineer handoffs at the ticket boundary). Olaniran retains Bridge-service hardening, webhook server, and outbound API work that does **not** touch IBEX directly.

## TL;DR

- **Architectural correction (2026-04-22 13:09 ET, Dread):** Phase 1 scope is a **Cash Wallet swap** — the IBEX ETH-USDT account **IS** the Flash Cash Wallet (IBEX is the ledger; there is no parallel Flash-side USDT wallet). Migration is **per-user, permanent, non-reversible opt-in**. **ENG-297 (Lightning parity on the ETH-USDT wallet) is a Phase-1 launch blocker, not Phase 2.** JM users are included in the migration (Cashout V1 source wallet flips from USD → USDT for opted-in users).
- **2 tickets close** (already Done): ENG-280, ENG-281.
- **4 tickets in review** — let merge: ENG-278, ENG-279, ENG-282, ENG-283.
- **1 in progress** (ENG-284) — fold ENG-363 as acceptance.
- **6 existing re-scoped in place**: ENG-272, ENG-273 (split), ENG-274, ENG-276, ENG-285, ENG-286.
- **ENG-296 reframed** as "ETH-USDT Cash Wallet provisioning" (account provisioning on IBEX + Cash Wallet pointer flip), not raw "deposit address provisioning".
- **ENG-297 promoted** from Phase 2 post-launch → **Phase-1 launch blocker** under **Ben** (W1, post-15:36-ET IBEX-spine handoff).
- **14 new tickets to file**: ENG-351/352, ENG-353, ENG-349, ENG-350, ENG-354, ENG-355, ENG-358, ENG-359, ENG-360, ENG-356, **ENG-345/346 (opt-in)** (per-user Cash Wallet opt-in toggle, Nick+Ben), **ENG-348** (ERPNext audit row per Bridge↔IBEX USDT movement, **Ben** — reassigned 2026-04-22 15:52 ET), **ENG-357** (Cashout V1 source-wallet switch for opted-in JM users, Dread+Ben), **ENG-347** (Flash-maintained country allowlist superset, Dread+Nick).
- **4 acceptance items consolidated rather than filed separately:** outbound-timeout work (folded into ENG-286 scope), Bridge-fee persistence (folded into ENG-276 acceptance), backfill/replay tooling (folded into ENG-276 acceptance), one-VA-per-account schema constraint (now sub-issue ENG-363 of ENG-284).
- **3 mobile FE tickets** already exist: ENG-342, ENG-343, ENG-344 (Nick).
- **5 product/commercial tickets** (PROD-A..E) live outside this project.

## 1. Tickets by assignee

### 1.1 Olaniran — Integration Developer

The bulk of the engineering critical path lives here.

> **Reassignment (Dread 2026-04-22 15:36 ET + 15:52 ET):** five IBEX+Flash-touching tickets — **ENG-296**, **ENG-297**, **ENG-357**, **ENG-275**, **ENG-348** — are moved off Olaniran. ENG-296 + ENG-297 + ENG-348 → **Ben**. ENG-357 → **Dread + Ben**. ENG-275 server half → **Ben**. See §1.2 (Ben) and §1.4 (Dread) for the new homes; the rows below now omit them. The reasoning: Olaniran was carrying ~18 tickets including the entire IBEX integration spine; concentrating IBEX+audit work on Ben (who also owns ENG-38, the IBEX auth deprecation) keeps the IBEX touchpoints with one engineer and keeps the audit writer adjacent to the handlers it sits on top of.

| Wave | Linear / New | Title | Priority | State / Action |
|---|---|---|---|---|
| W1 | **ENG-345/346 (opt-in)** | Per-user Cash Wallet opt-in toggle (legacy USD → ETH-USDT, permanent, non-reversible) | Urgent | **File.** Joint — Ben (server: account flag, GraphQL mutation, state machine `legacy_usd → opt_in_pending → eth_usdt_ready → eth_usdt_active`) + Nick (mobile: opt-in CTA screen, confirmation copy emphasizing permanence, single-wallet-UI constraint). **Launch blocker.** See FLOWS §3d. |
| W2 | **ENG-276** | Deposit reconciliation Bridge↔IBEX | Urgent | Backlog → start after W1. **Launch blocker.** Fold the Bridge-fee-persistence and backfill/replay-tooling work in as acceptance items. |
| W3 | **ENG-349** | Withdrawal idempotency key on `bridgeInitiateWithdrawal` | High | **File.** Pass `Idempotency-Key` to `BridgeClient.createTransfer`. |
| W3 | **ENG-350** | Refund handler on `transfer.failed` | High | **File.** On off-ramp failure, the IBEX ETH-USDT balance needs to be restored on the IBEX side (i.e., the movement to Bridge is reversed / not settled). Joint with Ben for any Flash-side state reset (pending-withdrawal row, user-visible status). **No Flash-side wallet-ledger credit-back** — IBEX is the ledger. |
| W3 | **ENG-286** | Bridge API client timeout + circuit breaker | Medium | Backlog. **Re-scope:** ship timeout in W3, breaker in W7. |
| W3 | **ENG-285** | Validate withdrawal amount string (MED-1) | Medium | Backlog. Add API §8 reference; ≤6 dp, positive, min-amount. |
| W4 | **ENG-351/352** | Bridge service return shapes match GraphQL types (svc side) | High | **File.** Joint with Ben (GraphQL types side); Ben is ticket lead. |
| W4 | **ENG-354** | Distinct error for KYC tier ceiling (svc mapping) | Medium | **File.** Depends on ENG-353 from Ben. |
| W4 | **ENG-355** | Min-withdrawal floor enforcement | Medium | **File.** Lives next to the balance check in `BridgeService.initiateWithdrawal`. Floor value gated on PROD-D. |
| W4 | **ENG-356** | Implement 2% `developer_fee_percent` on Bridge transfers | High | **File.** Per ENG-272 commercial intent. See §5 flag #1. |
| W5 | **ENG-274** | Bridge sandbox E2E test suite | Medium | Todo. Joint with Dread (testing coordination). **E2E scope now includes opt-in flow + ETH-USDT wallet LN parity smoke test + ERPNext audit row verification.** |
| W7 | **ENG-286 (breaker half)** | Circuit breaker on Bridge client | Medium | Post-launch. |
| W7 | **ENG-360** | Webhook public-key rotation automation (svc side) | Medium | **File.** Joint with Dread (deployment side). |
| In Progress | **ENG-284** | Idempotency guard in `createVirtualAccount` (HIGH-4) | High | In Progress — fold ENG-363 (one-VA-per-account schema constraint) as acceptance. |
| In Review | **ENG-282** | Reject webhook if rawBody missing (HIGH-2) | High | Watch through merge. |
| In Review | **ENG-283** | Validate timestamp header before skew (HIGH-3) | High | Watch through merge. |

**Olaniran's load (after 15:36 ET + 15:52 ET handoff):** ~12 tickets across W1–W7 (was ~18; ENG-296, ENG-297, ENG-357, ENG-275-server, **ENG-348** all moved to Ben/Dread). Remaining critical path: **ENG-276 → ENG-349 → ENG-350 → ENG-352 (svc) → ENG-286**. ENG-345/346 (opt-in) is now ticket-led by Ben+Nick — Olaniran is no longer on the hook for the IBEX integration spine, and is no longer on the hook for the ERPNext audit writer either.

### 1.2 Ben — Flash Application Developer

Touches GraphQL, Mongoose schemas, Kratos, wallet/ledger primitives.

> **Reassignments inbound (Dread 2026-04-22 15:36 ET + 15:52 ET):** the IBEX+Flash backend spine moves here. Ben now owns the IBEX integration end-to-end (ENG-296 + ENG-297), the server-side push trigger (ENG-275), and — per Dread 15:52 ET — the **ERPNext audit-row writer (ENG-348)** that sits on top of the handlers Ben owns. Ben is also already on the hook for **ENG-38** (IBEX auth deprecation, due 2026-05-31), so concentrating all IBEX touchpoints with one engineer is intentional.
>
> **⚠ Schedule-risk concentration (Dread 2026-04-22 16:30 ET):** after the two handoffs Ben is the project's single biggest schedule risk. ~14 owned tickets in the Bridge project plus ENG-38 outside — heaviest in the team. **Ben's W1/W2 items are the project critical path** and should be marked as such in Linear (priority: Urgent; label: `critical-path`; project blocker: yes):
>
> 1. **ENG-296** (W1) — ETH-USDT Cash Wallet provisioning. Cross-project blocker (Cashout V1 too).
> 2. **ENG-297** (W1) — LN parity on ETH-USDT. Promoted to launch blocker 13:09 ET.
> 3. **ENG-345 (opt-in server)** (W1) — account flag + state machine + GraphQL mutation. Gates every Bridge flow.
> 4. **ENG-348** (W2) — audit-row writer. Finance/accounting requirement.
>
> Dread should explicitly monitor these four at standups and re-balance into Olaniran (Bridge-service-only work) or Dread (ENG-357 lead coordination) if W1 slips by more than a wave. Consider splitting **ENG-297** into `ENG-297-send` + `ENG-297-receive` at estimation time if scope feels heavy — that's a pre-baked relief valve.

| Wave | Linear / New | Title | Priority | State / Action |
|---|---|---|---|---|
| W1 | **ENG-296** *(reassigned from Olaniran 15:36 ET)* **[CRIT-PATH]** | ETH-USDT Cash Wallet provisioning (IBEX account + Cash Wallet pointer flip) | Urgent | Backlog → start now. **Launch blocker.** Per 2026-04-22 13:09 ET correction: the IBEX ETH-USDT account **IS** the Flash Cash Wallet. Scope = provision the IBEX ETH-USDT account and flip the Cash Wallet pointer for opted-in users. No parallel Flash-side USDT ledger. **Cross-project blocker** (also blocks Cashout V1 launch). |
| W1 | **ENG-297** *(reassigned from Olaniran 15:36 ET)* **[CRIT-PATH]** | Lightning parity on ETH-USDT Cash Wallet (LN invoice gen, send/pay, LNURL, balance, history) | Urgent | Backlog → **Phase-1 launch blocker** (was Phase 2). Mirrors existing IBEX USD wallet LN capabilities on the new IBEX ETH-USDT Cash Wallet. Depends on ENG-296. Per docs.ibexmercado.com/reference/welcome, IBEX supports LN on ETH-USDT accounts. **Suggested sub-tickets:** split into `ENG-297-send` and `ENG-297-receive` if scope feels heavy after estimation — pre-baked scope-relief valve per Dread 16:30 ET. |
| W1 | **ENG-345/346 (opt-in)** (server half) **[CRIT-PATH]** | Account opt-in flag + state machine + GraphQL mutation | Urgent | **File.** Joint — ticket lead with Nick (mobile half). Ben owns: `cashWalletOptIn` account field (or equivalent), state machine `legacy_usd → opt_in_pending → eth_usdt_ready → eth_usdt_active`, GraphQL mutation `cashWalletOptIn`, wiring the opt-in gate in front of every Bridge flow. **Launch blocker.** |
| W3 | **ENG-350** | Pending-withdrawal state reset on `transfer.failed` (Flash side) | High | **File.** Joint with Olaniran. Ben owns: reset the Mongoose `bridgeWithdrawals` row state + surface the failure to the user. **No wallet-ledger credit-back** — IBEX is the ledger; the USDT balance isn't debited on IBEX side until the off-ramp actually settles. |
| W4 | **ENG-351/352** | GraphQL types & resolvers payload-shape fix | High | **File. Ticket lead.** Align `bridgeAddExternalAccount`, `bridgeCreateVirtualAccount`, `bridgeInitiateKyc`, `bridgeInitiateWithdrawal` return types with the Bridge service shapes. Same for the 4 read queries. |
| W4 | **ENG-353** | GraphQL error-code differentiation for Bridge errors | High | **File.** Stop collapsing all Bridge errors to `INVALID_INPUT` in `mapAndParseErrorForGqlResponse`. Surface specific codes per BridgeError subclass. |
| W4 | **ENG-354** | Distinct error for KYC tier ceiling (gql side) | Medium | **File.** Joint with Olaniran. Depends on ENG-353. |
| W4 | **ENG-357** *(reassigned from Olaniran 15:36 ET — joint with Dread)* | Cashout V1: ETH-USDT as the first-class source wallet (with USDT→USD swap before JMD off-ramp); legacy USD = fallback for non-opted-in users only | High | **File.** Joint — **Dread leads the source-wallet selection logic + cross-project coordination** with the Cashout V1 spec; **Ben owns the account-flag plumbing / Cashout V1 GraphQL surface** + the Cashout V1 resolver branch. **Scope note:** this is the Bridge-side half of the change; the Cashout V1 project itself needs its spec updated separately to include the opt-in decision tree (Dread owns that, tracked on the Cashout V1 project's own ticket, not here). |
| W2 | **ENG-348** *(reassigned from Olaniran 15:52 ET)* **[CRIT-PATH]** | ERPNext audit-row writer for every Bridge↔IBEX USDT movement | High | **File.** Per Dread 15:52 ET: the audit writer sits on top of the `/crypto/receive` + `/deposit` + `/transfer` webhook paths Ben now owns (ENG-276 reconciliation + ENG-296/297 IBEX integration) — consolidating it with the handlers avoids cross-engineer handoffs at the ticket boundary. Scope = finance-facing ERPNext audit row per Bridge↔IBEX USDT movement. **Not a wallet ledger** (IBEX is the ledger). Dread remains the ERPNext contract counterpart; Ben implements. |
| W5 | **ENG-275** *(server half — reassigned from Olaniran 15:36 ET)* | Push notification on deposit (on-ramp settlement) and withdrawal completion — server trigger | Medium | Todo → start once W2/W3 are stable. **Scope expanded** to cover deposit-side push at `/crypto/receive` settlement (in addition to withdrawal-completion push). Coordinate with Nick on the mobile-client half. |
| W6 | **ENG-358** | Add `fee` / `developerFee` / `fxRate` / `quoteRate` columns to `bridgeWithdrawals` | Medium | **File.** Mongoose schema migration + GraphQL exposure. Prereq for ENG-276 reconciliation accuracy and finance reporting. |
| In Review | **ENG-278** | Use real account email in Bridge customer creation | High | In Review (Kratos lookup). Watch through merge. |
| Phase 2 (post-launch) | **ENG-298** | Schema cleanup — remove chain-specific fields (`bridgeTronAddress`, `bridgeEthAddress`) | Medium | Backlog → moved into this project as **Phase 2 / post-launch cleanup** (renumbered from Phase 3 now that ENG-297 is Phase 1). Migration script + tests. Depends on ENG-296 + ENG-297. |

**External dependency (NOT in this project):** **ENG-38** — IBEX auth deprecation (May 31, 2026). Ben owns it, Urgent, due 2026-05-31. Tracked separately from the Bridge project because it spans more than Bridge. **Concentration of IBEX work on Ben** (ENG-38 + ENG-296 + ENG-297 + ENG-275-server) is intentional after 15:36 ET — single point of context for the entire IBEX surface.

**Ben's load (after 15:36 ET + 15:52 ET inbound):** ~14 tickets (was ~9; gained ENG-296, ENG-297, ENG-357 svc-half, ENG-275-server, **ENG-348**) plus ENG-38 outside-project. Critical path: **ENG-296 (W1) → ENG-297 (W1) → ENG-345/346 (opt-in) server (W1) → ENG-348 (W2, adjacent to ENG-276) → ENG-351/352 + ENG-353 (W4) → ENG-357 (W4) → ENG-275-server (W5) → ENG-358 (W6) → ENG-298 post-launch**. Ben's load is now the heaviest in the project — Dread should monitor and re-balance into Olaniran (Bridge-service-only work) or Dread (ENG-357 coordination, ENG-348 fallback) if W1 or W2 looks at risk.

### 1.3 Nick — Mobile App / UI Developer

| Wave | Linear / New | Title | Priority | State / Action |
|---|---|---|---|---|
| W1 | **ENG-345/346 (opt-in)** (mobile half) | Cash Wallet opt-in CTA screen + confirmation copy | Urgent | **File.** Joint with Ben (server half). Nick owns: opt-in entry point in settings/wallet, confirmation modal emphasizing **"this is permanent and cannot be reversed"**, success state, single-wallet-UI constraint (only one Cash Wallet is visible in the UI — the active one per state machine). **Launch blocker.** |
| W1 | **ENG-343** | Pre-KYC form (name, email, type) | Medium | Todo. **Launch blocker for KYC.** Add acceptance item: "ToS-accept timestamp persisted to account". |
| W1 | **ENG-344** | FE: Pre-KYC & Region Check | Medium | Todo. Pairs with ENG-343; routes US users to hosted KYC flow. Region check **reads from the Flash-maintained allowlist** (see ENG-347) rather than the Bridge-returned 86-country list. |
| W2 | **ENG-342** | Deposit USD button + feature flag | Medium | Todo. Visibility gated on Bridge feature flag **and** on the user having opted in (state machine `eth_usdt_active`). |
| W4 | **PROD-E** (mobile half) | Quote / confirmation UX showing Bridge fee deduction | TBD | **File once PROD-A/B/C are pinned.** Show user the net amount they'll receive. |
| W5 | **ENG-275** (mobile half) | Push notification client config for deposit + withdrawal events | Medium | Coordinate with **Ben's** server-side trigger (server half reassigned from Olaniran to Ben 2026-04-22 15:36 ET). Deposit-side push is now in-scope (not just withdrawal completion). |

**Nick's load:** ~5–6 tickets, mostly W1–W2 (ENG-346 (opt-in mobile) + KYC + deposit entry) and W4–W5 (UX refinement + push). On the critical path for W1 user flow — the opt-in CTA is the funnel that unlocks Bridge access.

### 1.4 Dread — Project Lead

| Wave | Linear / New | Title | Notes |
|---|---|---|---|
| ongoing | **ENG-279** | Security audit meta-ticket | In Review. Close once HIGH-2/3/4 + MED-1/2 all merged. |
| W1 | **ENG-347** | Flash-maintained country allowlist (superset of Bridge's 86 countries) | **File.** Joint with Nick (mobile region check reads it) and Dread owns the list policy. Don't ship the Bridge-returned 86-country list raw — maintain a Flash-side allowlist (possibly stricter for Phase 1 launch) with commercial + compliance sign-off. **Launch blocker.** |
| W4 | **ENG-357** *(reassigned from Olaniran 15:36 ET — Dread leads)* | Cashout V1 source-wallet selection logic + cross-project coordination | **File / lead.** Dread owns: (a) the source-wallet selection logic ("default to ETH-USDT when opted in; fall back to legacy USD only if not"), (b) the USDT→USD swap step via IBEX before the JMD off-ramp, (c) coordination with the Cashout V1 project's spec update for the opt-in decision tree. **Ben** keeps the account-flag plumbing / Cashout V1 GraphQL surface. Pairs with the Cashout V1 cross-project coordination row below. |
| W5 | **ENG-273a** | Wire Bridge alerts to PagerDuty / Slack | Split from ENG-273. Requires wiring alerts that Olaniran ships. |
| W5 | **ENG-273b** | Bridge dashboards (volume / latency / error rate) | Split from ENG-273. **Add panel for ERPNext-audit-row-write failures** (ENG-348 — Ben-owned as of 15:52 ET). |
| W5 | **ENG-274** (lead) | Sandbox E2E test plan + execution coordination | Joint with Olaniran. Owns "test plan + drill". **Plan now includes opt-in flow + ETH-USDT LN parity smoke test + ERPNext audit row verification.** |
| W6 | **ENG-272** | Drill OPERATIONS.md against staging | Re-scope to "rehearse one playbook end-to-end" — include the opt-in rollout dry-run. |
| W7 | **ENG-359** | Move Bridge API key from YAML config to vault | Deployment / infra. |
| W7 | **ENG-360** | Webhook public-key rotation policy (deployment side) | Joint with Olaniran (config loading). |
| ongoing | **PROD-A..D** | Commercial decisions (limits / fees / markup / overlay caps) | Owns the contract conversation with Bridge sales. |
| ongoing | **Cashout V1 cross-project coordination** | ENG-296 is now a launch blocker for **two** projects: Bridge Wallet Integration AND Cashout V1 | **Confirmed by Dread 2026-04-22 14:15 ET; ownership re-cast 15:36 ET:** Dread leads the source-wallet selection work directly via ENG-357 (W4 row above). Still in scope: (1) update the Cashout V1 project spec to include the opt-in decision tree, (2) add a cross-project `blocks` link from ENG-296 to the Cashout V1 project's launch milestone, (3) coordinate Cashout V1 launch ordering with this project so ENG-296 (now Ben-owned) sequencing is visible to both sides. |
| project hygiene | **ENG-16** cancellation | Cancel "Instant Fiat Conversion - Seamless Currency Exchange" | Empty description, superseded by this project. **Cancel as superseded.** |
| project hygiene | **ENG-297 Phase-1 move** | Move ENG-297 from Phase 2 / post-launch into Phase 1 / W1 launch blocker | Per 2026-04-22 13:09 ET correction. Update Linear project + priority (High → Urgent). |
| project hygiene | **ENG-298 project move** | Add ENG-298 into the Bridge Wallet Integration project as Phase 2 / post-launch | Renumbered from Phase 3 now that ENG-297 is Phase 1. |
| cross-project visibility | **ENG-38** coordination | IBEX auth deprecation (May 31, 2026) | **Not** moved into the Bridge project — Ben owns it on its own ticket, Urgent, due 2026-05-31. Dread tracks it as an external launch dependency in EXECUTIVE-SUMMARY §4 + §11 risk #6 + OPERATIONS §3 deployment dependency. |
| ongoing | review/QA | All tickets | Code review, sign-off, deployment gate. |

**Dread's load (after 15:36 ET + 15:52 ET inbound):** ~8 owned tickets (incl. ENG-347 as launch blocker + **ENG-357 as W4 lead**; ENG-348 co-own removed 15:52 ET — now Ben-owned) + 4 project-hygiene actions (incl. ENG-297 Phase-1 move + Cashout V1 cross-project coordination) + project-wide review/coordination + commercial + ENG-38 cross-project tracking + ERPNext contract conversation (unchanged — still Dread's counterpart). Hands-on candidates: {ENG-359, ENG-360, ENG-355}.

## 2. Recommended launch sequence (with assignees)

Items in the same wave run in parallel.

| Wave | Goal | Tickets (owner) |
|---|---|---|
| **W1** | Provision the new Cash Wallet + opt-in path + region policy | **ENG-296 (Ben)** · **ENG-297 (Ben)** · ENG-345/346 (opt-in) (Ben+Nick) · ENG-347 (Dread+Nick) · ENG-343 (Nick) · ENG-344 (Nick) · ENG-278 close-out (Ben — In Review) |
| **W2** | Unblock the deposit — Bridge→IBEX ETH-USDT settlement with audit trail | ENG-276 (Olaniran) · **ENG-348 (Ben — reassigned 15:52 ET)** · ENG-342 (Nick) |
| **W3** | Make the withdrawal safe | ENG-349 (Olaniran) · ENG-350 (Olaniran + Ben) · ENG-286 timeout half (Olaniran) · ENG-285 (Olaniran) |
| **W4** | Make the app show useful states + close the JM loop | ENG-351/352 (Ben + Olaniran) · ENG-353 (Ben) · ENG-354 (Ben + Olaniran) · ENG-355 (Olaniran) · ENG-356 (Olaniran) · **ENG-357 (Dread + Ben)** · PROD-E (Nick) |
| **W5** | Make it observable | ENG-273a (Dread) · ENG-273b (Dread) · ENG-274 (Dread + Olaniran) · **ENG-275 (Ben + Nick — deposit + withdrawal push)** |
| **W6** | Make the books match | ENG-358 (Ben) · ENG-272 drill (Dread) · Bridge-fee-persistence acceptance fold-in (Olaniran, on ENG-276) |
| **W7** | Harden | ENG-286 breaker half (Olaniran) · ENG-359 (Dread) · ENG-360 (Dread + Olaniran) · ENG-363 fold-in (Olaniran, on ENG-284) |

**Hard launch gate (refined 2026-04-22 16:30 ET per Dread — not everything in W5 is equally launch-blocking):**

- **Must-have for launch** (blocks ship): all of W1–W4 green + the W5 items that are genuinely launch-critical:
  - **ENG-274** (sandbox E2E test plan + execution) — no launch without a rehearsed end-to-end drill.
  - **ENG-273 child 1 — alerts to PagerDuty/Slack** — must exist before we take real user traffic.
  - **ENG-275 server trigger for deposit completion** (the on-ramp push at `/crypto/receive` settlement) — users need to know their money landed.
- **Strong should-have** (target for launch but not a hard gate):
  - **ENG-273 child 2 — dashboards** (volume / latency / error rate, incl. ERPNext-audit-failure panel) — highly desirable day-1 observability, but absence is survivable for the first week if alerts cover the paging-level signals.
  - **ENG-275 server trigger for withdrawal completion** (off-ramp push) — nice; withdrawal users will get email from Bridge + Flash + bank anyway.
  - **ENG-275 mobile client config** (Nick's half) — in-scope for launch; can ship a soft update post-launch if the mobile release train slips.
- **Post-launch (W6–W7):** can be in-flight at launch. ENG-358 (fee columns), ENG-286 breaker half, ENG-359/11 (key rotation + vault), ENG-363 schema constraint sub-issue.

Per Dread: "we should be careful not to over-gate." Treat W5 items as a **graduated gate** — the three must-haves listed above are blockers; the rest should be target-for-launch but not blockers.

## 3. Per-role critical paths (visual)

_Updated 2026-04-22 15:36 ET + 15:52 ET + 16:30 ET to reflect Olaniran→Ben/Dread handoff (incl. ENG-348 → Ben) and the critical-path marking on Ben's W1/W2 per Dread 16:30 ET. `[⚠ CRIT-PATH]` items are the project's single biggest schedule risk; they should be Urgent + `critical-path` labelled in Linear._

```
Ben       [⚠ CRIT-PATH:] ENG-296 ─→ ENG-297 ─→ ENG-345 ─→ ENG-348  ──→  ENG-351(gql) ─→ ENG-353 ─→ ENG-357(flag) ─→ ENG-275(server) ─→ ENG-358 ─→ ENG-298
              │
              └─ ENG-278 (In Review) · ENG-38 (external, May 31) · ENG-350(state) (joint with Olaniran)

Olaniran  ENG-276 ─→ ENG-349 ─→ ENG-350(svc) ─→ ENG-352(svc) ─→ ENG-354(svc) ─→ ENG-355 ─→ ENG-356 ─→ ENG-274(joint) ─→ ENG-286 breaker
              (no IBEX integration spine, no ERPNext audit writer — Bridge service / webhook server / outbound API only)

Nick      ENG-346 ─→ ENG-343 + ENG-344 ─→ ENG-342 ─────────────────── PROD-E ─→ ENG-275(client)

Dread     ENG-347 ─→ ENG-357(lead) ─→ ENG-279 close ─→ ENG-273a/b ─→ ENG-274 drill ─→ ENG-272 rehearse ─→ ENG-359/11
                                   (PROD-A..D contract work + Cashout V1 cross-project coordination in parallel throughout)
```

## 4. Net recommended actions (from comparison report)

| Action | Count | Tickets |
|---|---|---|
| **Close** (already Done) | 2 | ENG-280, ENG-281 |
| **Watch / let merge** (In Review) | 4 | ENG-278, ENG-279, ENG-282, ENG-283 |
| **In-progress, no change** | 1 | ENG-284 (+ fold ENG-363 as acceptance) |
| **Re-scope description only** | 7 | ENG-272, ENG-273 (split into 273a + 273b), ENG-274, ENG-275 (scope expand deposit+withdrawal push), ENG-276 (absorbs Bridge-fee-persistence + backfill/replay tooling), ENG-285, ENG-286, **ENG-296 (reframe as Cash Wallet swap)** |
| **Promote / reclassify** | 1 | **ENG-297 (Phase 2 → Phase 1 launch blocker)** |
| **File new** | **14** | ENG-351/352, ENG-353, ENG-349, ENG-350, ENG-354, ENG-355, ENG-358, ENG-359, ENG-360, ENG-356, **ENG-345/346 (opt-in), ENG-348, ENG-357, ENG-347** |
| **Retract from earlier proposal** | 4 | outbound-timeout (into ENG-286), Bridge-fee persistence (into ENG-276), backfill/replay tooling (into ENG-276), one-VA-per-account schema constraint (now sub-issue ENG-363 of ENG-284) |
| **Mobile-side, already filed** | 3 | ENG-342, ENG-343, ENG-344 |
| **Product/commercial, file outside this project** | 5 | PROD-A (Bridge limits), PROD-B (Bridge fees), PROD-C (markup model), PROD-D (overlay caps), PROD-E (quote UX) |

## 5. Cross-cutting flags (from comparison report)

| # | Flag | Action |
|---|---|---|
| **1** | **FEES inconsistency.** ENG-272 body says "verifying **2%** tx+orchestration is being applied correctly" — commercial intent. FEES.md says **zero charged today** (verified in code). | **File ENG-356** "Implement 2% `developer_fee_percent`" (Olaniran). Update FEES.md §4 to reflect 2% as the decided markup model. |
| **2** | **ENG-276 + ENG-296 together cover both halves of the deposit pipeline.** No need to split ENG-296 as the earlier proposal did. | Retract split. Pair them in W1+W2. |
| **3** | **Withdrawal idempotency really is missing** — ENG-284 covers VA only. | File ENG-349 (Olaniran). |
| **4** | Earlier proposal missed ENG-276, ENG-278, ENG-282, ENG-283, ENG-284, ENG-342, ENG-344. | Reflected in the §1 by-assignee tables. |
| **5** | ENG-279 meta-ticket can close once children land. | Watch — normal lifecycle. |

## 5A. Ticket boundary discipline (overlap prevention)

Added 2026-04-22 16:30 ET per Dread. Several of the new tickets sit close
enough together that people will blur them unless each Linear issue has
an **explicit scope / non-goals / dependencies / acceptance** block.
This section is the authoritative boundary map — copy the scope/non-goals
lines directly into each Linear issue description when filing.

### 5A.1 ENG-351/352 / ENG-353 / ENG-354 — GraphQL-surface triad

Three separate Ben-owned GraphQL tickets that superficially overlap. They
must ship together (mutual block between ENG-351/352 and ENG-353; ENG-354 blocked
on ENG-353) but they are **not** one ticket.

**ENG-351/352 — GraphQL types & resolvers: payload-shape fix.**
- **Scope:** Align `bridgeAddExternalAccount`, `bridgeCreateVirtualAccount`, `bridgeInitiateKyc`, `bridgeInitiateWithdrawal` mutation return types + the 4 read queries with the Bridge service's actual response shapes.
- **Non-goals:** Error mapping (→ ENG-353). KYC tier ceiling (→ ENG-354). Service-side shape corrections (→ Olaniran's ENG-352 svc half — joint ticket).
- **Dependencies:** None blocking entry; mutual block with ENG-353 at ship time (ship together).
- **Acceptance:** Every mutation/query return type in the GraphQL schema matches what `BridgeService` actually returns; type-check passes end-to-end; existing client assumptions documented as "shape changed — update mobile".

**ENG-353 — GraphQL error-code differentiation for Bridge errors.**
- **Scope:** Stop collapsing every Bridge error to `INVALID_INPUT` in `mapAndParseErrorForGqlResponse`. Surface a distinct GraphQL error code per `BridgeError` subclass (network, validation, rate-limit, KYC ceiling, etc.).
- **Non-goals:** Return-shape alignment (→ ENG-351/352). Per-error UX copy (Nick's future ticket). Service-side error subclass refactor — tickets stays in the mapping layer.
- **Dependencies:** Mutual block with ENG-351/352 (ship together). Prereq for ENG-354.
- **Acceptance:** Every `BridgeError` subclass maps to a distinct `extensions.code`; no Bridge error reaches the client as generic `INVALID_INPUT` unless it is genuinely an input-validation failure.

**ENG-354 — Distinct error for KYC tier ceiling (both halves).**
- **Scope:** Surface a specific `KYC_TIER_CEILING_EXCEEDED` code (or similar) when the Bridge API rejects a withdrawal for exceeding the user's current KYC tier cap. Joint: Olaniran owns the svc-side `BridgeError` subclass; Ben owns the gql mapping.
- **Non-goals:** Re-KYC upgrade flow itself (Nick's mobile follow-up). The KYC tier numbers themselves (PROD-A commercial decision). Generic error mapping (→ ENG-353).
- **Dependencies:** Blocked by ENG-353 (needs the differentiation plumbing). Feeds the mobile app's "upgrade your verification to withdraw more" CTA (not in this ticket).
- **Acceptance:** A sandbox over-cap withdrawal attempt returns the specific error code on both service and gql layers; mobile can branch on it.

### 5A.2 ENG-276 vs ENG-348 — reconciliation vs audit

Two Ben/Olaniran tickets that both touch the deposit pipeline. They are
**not** the same ticket.

**ENG-276 — Deposit reconciliation Bridge↔IBEX. (Olaniran, W2.)**
- **Scope:** Periodic reconciliation worker that compares Bridge-side deposit events against IBEX-side ETH-USDT settlement events and flags a 24h Bridge-without-IBEX gap as an orphan for ops to investigate. Persists the Bridge fee value (former Bridge-fee-persistence acceptance, folded in). Ships replay tooling for stuck deposits (former backfill/replay-tooling acceptance, folded in).
- **Non-goals:** Writing finance-facing ledger rows (→ ENG-348). Wallet-balance bookkeeping (IBEX is the ledger — not Flash's job). User-visible withdrawal state (→ ENG-350).
- **Dependencies:** ENG-296 (nothing to reconcile until the account exists).
- **Acceptance:** An orphan event (Bridge fires, IBEX doesn't within 24h, or vice versa) shows up in ops tooling with enough context to triage; the replay CLI can re-run a stuck `transfer.completed` handler against a chosen transfer-id.

**ENG-348 — ERPNext audit-row writer. (Ben, W2.)**
- **Scope:** Finance/accounting requirement. Write one ERPNext Journal Entry / audit row per Bridge↔IBEX USDT movement (on-ramp deposit + off-ramp transfer; both success and failure legs). Writes from the `/crypto/receive` + Bridge `/deposit` + `/transfer` webhook handlers.
- **Non-goals:** Reconciliation-gap detection (→ ENG-276). Flash-side wallet-ledger credit (does not exist — IBEX is the ledger). Reversing IBEX-side balance on failure (not applicable — Flash side only records).
- **Dependencies:** ENG-296 (audit targets the new account). ENG-276 runs orthogonally — they share the event source but write different sinks.
- **Acceptance:** Every `/crypto/receive` + `transfer.completed` + `transfer.failed` fire produces exactly one ERPNext row (idempotent on event id); finance can pull a month-over-month reconcilable report from ERPNext alone.

### 5A.3 ENG-345/346 (opt-in) vs ENG-357 — opt-in state vs source-wallet routing

Two tickets that look similar but live in different layers of the stack.

**ENG-345/346 (opt-in) — Cash Wallet opt-in toggle + state machine. (Ben+Nick, W1.)**
- **Scope:** Account-level opt-in flag; per-user state machine `legacy_usd → opt_in_pending → eth_usdt_ready → eth_usdt_active`; GraphQL mutation `cashWalletOptIn`; mobile opt-in CTA + permanence-emphasizing confirm modal; single-wallet-UI enforcement. **This is the identity of "which Cash Wallet does the user have".**
- **Non-goals:** Which wallet Cashout V1 sources from (→ ENG-357). Reversal / off-ramp back to USD wallet (explicitly out of scope — terminal one-way state machine). Migration automation for existing users (individual per-user opt-in only).
- **Dependencies:** ENG-296 + ENG-297 (target wallet must exist + have LN parity before a user can land in `eth_usdt_active`).
- **Acceptance:** An opted-in user's account surfaces a single Cash Wallet (the ETH-USDT one); a non-opted-in user sees only the legacy USD wallet; the state transitions are durable and tested; no path exists for a user to transition backward.

**ENG-357 — Cashout V1 source-wallet selection logic. (Dread lead + Ben, W4.)**
- **Scope:** At Cashout V1 initiation time, read the account's opt-in state and route: `eth_usdt_active` → source from IBEX ETH-USDT (USDT→USD swap via IBEX before the JMD off-ramp); otherwise → source from legacy USD wallet. Dread owns the routing logic + cross-project spec update; Ben owns the account-flag plumbing + the Cashout V1 resolver branch.
- **Non-goals:** The opt-in state itself (→ ENG-345/346 (opt-in)). Cashout V1's general UX / FX / limits (stays on the Cashout V1 project). The USDT→USD swap primitive on IBEX (already exists — this ticket just calls it).
- **Dependencies:** ENG-345/346 (opt-in) (needs the opt-in flag to be readable). ENG-296 (needs the target wallet to exist).
- **Acceptance:** A JM user who opts in can initiate Cashout V1 and the source-wallet debit happens on the ETH-USDT account (with the USDT→USD swap step visible in logs/audit); a non-opted-in JM user's Cashout V1 continues to debit the legacy USD wallet unchanged.

### 5A.4 Summary: where the edges live

| Dimension | Lives in | Does **not** live in |
|---|---|---|
| GraphQL return shape | ENG-351/352 | ENG-353, ENG-354 |
| GraphQL error code | ENG-353 | ENG-351/352, ENG-354 (except KYC-ceiling case) |
| KYC-tier-ceiling error | ENG-354 | ENG-353 (which only sets up the plumbing) |
| "Did Bridge and IBEX agree?" | ENG-276 | ENG-348 |
| "Did finance see the movement?" | ENG-348 | ENG-276 |
| "Which wallet does the user have?" | ENG-345/346 (opt-in) | ENG-357 |
| "Which wallet does Cashout V1 debit?" | ENG-357 | ENG-345/346 (opt-in) |

## 6. Linear project hygiene asks

Split into **required** (core correctness of the board) and **nice-if-available** (permission- or tooling-dependent). Per Dread 2026-04-22 16:30 ET: Linear permissions and custom-field creation can be uneven, so only the first group blocks starting the project update.

### 6A. Required — core correctness

These are the floor for a usable board; every one of them must be done before the first engineer picks up a ticket from this project.

- **Right issues** filed (all 14 of the originally-placeholder tickets + ENG-356 are now in §1).
- **Right owners** assigned per §1.1–§1.4 tables (not the pre-15:36-ET owners).
- **Right priority:** everything in the §1.2 Ben W1/W2 `[⚠ CRIT-PATH]` block + the Olaniran W1/W2 blockers + the Nick W1 items are Urgent. Everything else follows its table's priority column.
- **Right project placement:** all tickets in this list attached to the Bridge Wallet Integration Linear project **except** ENG-38 (stays on its own ticket, tracked from this project as an external launch dependency).
- **Critical-path marker:** Ben's four `[⚠ CRIT-PATH]` W1/W2 items (ENG-296, ENG-297, ENG-345 (opt-in server), ENG-348) marked as such — either via a `critical-path` label (preferred) or via the description-first-line `⚠ CRIT-PATH:` prefix (fallback if label creation is permission-blocked).
- **Block-on links** (the dependency web — broken deps cause wasted work):
  - ENG-354 ← ENG-353
  - Bridge-fee-persistence acceptance ← ENG-358 (acceptance on ENG-276)
  - ENG-350 ← ENG-296 (need a successful flow to test refund)
  - ENG-275 ← W2 (nothing to push about until deposits settle)
  - ENG-351/352 ↔ ENG-353 (mutual block — ship together)
  - **ENG-345/346 (opt-in) ← ENG-296 + ENG-297** (can't activate opt-in until target wallet + LN parity exist)
  - **ENG-348 ← ENG-296** (nothing to audit until the account exists)
  - **ENG-357 ← ENG-345/346 (opt-in)** (depends on the opt-in flag being readable)
  - **ENG-342 ← ENG-345/346 (opt-in)** (deposit CTA gated on `eth_usdt_active` state)
  - **ENG-344 ← ENG-347** (region check reads Flash allowlist)
- **ENG-273 structural decision (Dread 16:30 ET):** **Keep ENG-273 as parent/meta in Linear.** Create two **sub-issues** (Linear's native parent/child), *not* informal `ENG-273a`/`ENG-273b` suffix tickets. The "a/b" names in this doc are placeholders — the actual sub-issues will receive their own Linear-assigned IDs at creation (e.g. `ENG-3xx`). Acceptance on ENG-273 itself = both sub-issues closed. The two sub-issues:
  - **ENG-273 child 1:** Wire Bridge alerts to PagerDuty / Slack. (Dread, W5.)
  - **ENG-273 child 2:** Bridge dashboards (volume / latency / error rate) + ERPNext-audit-failure panel. (Dread, W5.)
- **ENG-363 structural decision (Dread 16:30 ET):** **ENG-363 becomes a sub-issue of ENG-284**, not a fold-in acceptance item. Rationale: the one-VA-per-account schema constraint is a Mongoose-level change that deserves its own commit + its own test + its own migration strategy; burying it as an acceptance checkbox on ENG-284 loses that traceability. ENG-284 closes when both the handler idempotency guard (parent) and the schema constraint (child ENG-363) are in.
- **Project description** in Linear links to `docs/bridge-integration/EXECUTIVE-SUMMARY.md`.

### 6B. Nice-if-available — permission/tooling gated

Do if the workspace allows; skip without blocking the project start.

- **Custom field "Doc reference"** on every ticket → `EXEC §`, `FLOWS §`, `API §`, etc. Useful for "show me every ticket touching the withdrawal flow" queries; not required for correctness.
- **Custom field "Wave"** → `W1`–`W7` so the launch critical path is queryable. If custom-field creation is blocked, use existing milestones or cycle assignments as a substitute; the wave is already visible on each ticket's description.
- **Labels by area:** `area:bridge-svc` (Olaniran), `area:flash-app` (Ben), `area:mobile` (Nick — already in use on ENG-343/344), `area:ops` (Dread).

### 6C. Fallbacks if 6B is blocked

- Replace the wave custom field with a `W1`..`W7` prefix in each ticket's title (awkward but queryable).
- Replace the doc-reference custom field with a mandatory first-line in each ticket description: `Doc ref: FLOWS §4 / ARCHITECTURE §5.4`. Grep-compatible.
- Replace area labels with the `area:*` prefix convention used on ENG-343/344 today.

## 7. What this plan deliberately does not touch

- **JM Cashout V1 work** *broadly* — separate project (FLOWS §5). **Exceptions:** (1) ENG-357 is in this plan because making ETH-USDT the first-class Cashout V1 source wallet is a direct consequence of the Cash Wallet swap; (2) ENG-296 is now a cross-project launch blocker for Cashout V1 as well (confirmed Dread 2026-04-22 14:15 ET) — tracked via the cross-project coordination row in §1.4. Anything else about Cashout V1 UX/FX/limits stays on the Cashout V1 project and needs that project's own opt-in-decision-tree spec update.
- **General IBEX maintenance** unrelated to ENG-296/ENG-297/ENG-276.
- **Mobile app changes unrelated to ENG-345/346 (opt-in) / ENG-351/352 / ENG-353 / ENG-354 / PROD-E** — Nick's other backlog.
- **PROD-A..E themselves** — these belong on a Product/Finance project, with this plan taking dependencies on them where flagged.
- **Rollback / reversal of the opt-in** — explicitly out of scope per Dread 2026-04-22. The state machine is one-way terminal. Users who opt in cannot opt back out to the legacy USD Cash Wallet.

## Document History

| Date | Author | Change |
|---|---|---|
| 2026-04-22 | Taddesse (Dread review) | Initial proposal derived from the rewritten doc set. |
| 2026-04-22 | Taddesse (Dread review) | Reconciled against live Linear state (per `LINEAR-VS-PROPOSAL.md`); reorganized by role/assignee for the new team structure (Dread lead; Olaniran integration; Ben Flash app; Nick mobile/UI). |
| 2026-04-22 | Taddesse (Dread review) | Cascade from ENG team orphan scan: added ENG-297 (Phase 2 Lightning) under Olaniran and ENG-298 (Phase 3 schema cleanup) under Ben as post-launch waves of this project; added ENG-16 cancellation + ENG-297/298 project moves to Dread project-hygiene list; added ENG-38 (IBEX auth May 31, 2026) as cross-project external dependency owned by Ben (Urgent, due 2026-05-31). Currency Precision tickets (ENG-318/319/326) intentionally left **out** of this project plan per Dread. |
| 2026-04-22 18:30 ET | Taddesse (Dread directive: "go!") | **Cascade #8 — Linear mirror executed.** Per Dread 16:41 ET ("lets go ahead and update Linear now") + 18:11 ET ("1. B / 2. Dread / 3. skip / 4. one direction / 5. attempt, fall back if blocked. go!"). All ~50 mutations against the live Linear workspace landed cleanly. **Filed:** 16 new tickets ENG-345 → ENG-360 (the opt-in work was split into server/mobile = ENG-345 + ENG-346, the GraphQL fix was split into gql/svc = ENG-351 + ENG-352, both per Option B). **Sub-issues:** ENG-361 (alerts) + ENG-362 (dashboards) under ENG-273; ENG-363 (one-VA-per-account schema constraint) under ENG-284. **Reassigned (8):** ENG-273/274/298 → Dread; ENG-275/297 → Ben; ENG-276/285/286 → Olaniran. **Priority bumps (4):** ENG-275 + ENG-297 → Urgent; ENG-273 + ENG-274 → High. **Re-scoped descriptions (11):** ENG-272/273/274/275/276/284/285/286/296/297/298 — each with `Doc ref:` first line + §5A scope/non-goals/dependencies/acceptance blocks where applicable. **Critical-path label** applied to ENG-296, ENG-297, ENG-345 (opt-in server), ENG-348 (ERPNext audit). **Title rewrites:** ENG-296 → "ETH-USDT Cash Wallet provisioning..."; ENG-297 → "Lightning parity on ETH-USDT Cash Wallet (launch blocker)" (drops the misleading "[Phase 2]" prefix). **Blocks relations (12):** plan's 11 + 1 added for opt-in split correctness (ENG-345 blocks ENG-346). **Project description** updated with short summary (255 chars) + long markdown content body linking to the doc set. **Skipped per Dread defaults:** cross-project blocks link from ENG-296 to a Cashout V1 issue (no specific target picked — Dread does in UI). **Custom fields:** Linear's GraphQL API doesn't expose issue custom field create/update — using 6C fallbacks (`Doc ref:` first line + `⚠ CRIT-PATH:` prefix + wave name in body). **Surprise wins:** all four `area:*` labels (`area:bridge-svc`, `area:flash-app`, `area:ops`, `critical-path`) already existed at workspace level — no permission issues. **Doc edit:** added historical placeholder map at the top of this file (placeholders → live IDs ENG-345–ENG-363). | Taddesse + Dread |
| 2026-04-22 16:30 ET | Taddesse (Dread directive) | **Pre-Linear-mirror cleanup cascade.** Per Dread: "the plan is good enough to move into Linear, but I'd fix a few red flags first so we don't encode confusion into the Linear board." Three passes: (1) **Stale owner refs fixed.** TL;DR ENG-297 line: "under Olaniran (W1/W2)" → "under **Ben** (W1, post-15:36-ET IBEX-spine handoff)". Nick §1.3 ENG-275 mobile-half line: "Coordinate with Olaniran's server-side trigger" → "Coordinate with **Ben's** server-side trigger (reassigned from Olaniran to Ben 2026-04-22 15:36 ET)". (2) **Ben flagged as schedule-risk concentration.** Added an explicit `[⚠ CRIT-PATH]` marker on Ben's four W1/W2 items (ENG-296, ENG-297, ENG-345 (opt-in server), ENG-348) in §1.2 + §3 ASCII; added a callout block in §1.2 preamble explaining the concentration + naming Dread's monitoring obligation + pre-baking the ENG-297 split (`ENG-297-send`/`ENG-297-receive`) as a scope-relief valve. (3) **Ticket-boundary discipline.** Added new §5A "Ticket boundary discipline (overlap prevention)" with explicit scope / non-goals / dependencies / acceptance for the three at-risk pairs: ENG-351/352 ↔ ENG-353 ↔ ENG-354 (GraphQL-surface triad), ENG-276 ↔ ENG-348 (reconciliation vs audit), ENG-345/346 (opt-in) ↔ ENG-357 (opt-in state vs source-wallet routing) + a summary-matrix of "where each edge lives". (4) **ENG-273 structural decision:** keep ENG-273 as parent/meta, create two sub-issues via Linear's native parent/child (not informal `273a`/`273b` suffix tickets); "a/b" names in the doc are placeholders, real IDs assigned at creation. (5) **ENG-363 structural decision:** promote to sub-issue of ENG-284 (not a fold-in acceptance checkbox) — schema constraint deserves own commit/test/migration. (6) **§6 rewritten as 6A required / 6B nice-if-available / 6C fallbacks** — custom fields + labels marked as permission-gated, not required to start; added explicit fallbacks if Linear-workspace permissions block custom-field creation. (7) **§2 launch gate tightened** — W5 reframed as a **graduated gate**: ENG-274 + ENG-273-child-1 (alerts) + ENG-275 server-deposit trigger are must-haves; ENG-273-child-2 dashboards + ENG-275 withdrawal half + ENG-275 mobile half are strong-should-haves, not blockers. | Taddesse + Dread |
| 2026-04-22 15:52 ET | Taddesse (Dread directive) | **ENG-348 reassigned to Ben.** Per Dread: the ERPNext audit-row writer belongs on Ben rather than Olaniran (or Dread as relief). Rationale: after the 15:36 ET handoff the `/crypto/receive` + `/deposit` + `/transfer` webhook paths the audit writer sits on top of are all Ben-owned (ENG-276 reconciliation still Olaniran, but ENG-296/297 IBEX integration is Ben) — consolidating the audit writer with the handlers that emit the USDT movement events avoids cross-engineer handoffs at the ticket boundary. Changes: (a) removed from Olaniran's §1.1 table (was W2 row); (b) added to Ben's §1.2 table as W2 row; (c) removed Dread's §1.4 "optional co-own" row; (d) updated TL;DR, §0 cross-cutting note, §2 wave table W2 row, §3 critical-path ASCII (Ben line gains ENG-348 between ENG-345/346 (opt-in) and ENG-351/352; Olaniran line loses it), Olaniran/Ben/Dread load summaries (Olaniran ~13→~12, Ben ~13→~14, Dread ~9→~8). Dread remains the ERPNext contract counterpart; ENG-273b dashboard panel note updated to note Ben ownership. |
| 2026-04-22 15:36 ET | Taddesse (Dread directive) | **Olaniran load-shed.** Per Dread: Olaniran is overloaded; the IBEX+Flash backend tickets must come off his list. Reassigned **ENG-296** (ETH-USDT Cash Wallet provisioning) and **ENG-297** (LN parity on ETH-USDT) to **Ben** — concentrating all IBEX touchpoints with the engineer who already owns ENG-38 (IBEX auth deprecation). Reassigned **ENG-357** to **Dread (lead, source-wallet selection logic + cross-project coordination) + Ben (account-flag GraphQL surface)** — Dread already coordinates Cashout V1 spec; this is a one-line ownership change. Reassigned **ENG-275 server half** to **Ben** (mobile half stays on Nick). Updated Olaniran's §1.1 table (now ~13 tickets, was ~18; removed the four reassigned rows + load summary), Ben's §1.2 (added the four inbound rows + new Ben-leads-IBEX preamble + load summary now ~13), Dread's §1.4 (added ENG-357 W4 lead row + reworded Cashout V1 cross-project coordination row + load summary), §0 cross-cutting note, §2 wave table (W1/W4/W5 owners), §3 critical-path ASCII (redrawn — Ben now owns the IBEX spine; Olaniran is Bridge-service-only). ENG-348 stays defaulted to Olaniran (Dread relief unchanged). | Taddesse + Dread |
| 2026-04-22 14:15 ET | Taddesse (Dread confirmation) | **Cashout V1 scope follow-up.** Dread confirmed: Cashout V1's source wallet must flip. Stronger than the initial framing — **ETH-USDT is the first-class Cashout V1 source wallet on launch**, not merely a "switch for opted-in users". Legacy USD is a fallback for non-opted-in users only. **ENG-296 is now a cross-project launch blocker for both Bridge Wallet Integration and Cashout V1.** Reworded ENG-357 row accordingly. Replaced the "Cashout V1 contradiction flag" action-row in Dread's §1.4 with a "Cashout V1 cross-project coordination" row capturing the three follow-up actions (Cashout V1 spec update, ENG-296 cross-project blocks link, launch ordering coordination). Updated §7 exclusions to call out ENG-296 as the cross-project dependency. |
| 2026-04-22 13:09 ET | Taddesse (Dread directive) | **IBEX-ETH-USDT-is-the-wallet cascade.** (1) Reframed ENG-296 from "deposit address provisioning" to "ETH-USDT Cash Wallet provisioning" (Olaniran) — IBEX ETH-USDT account **IS** the Flash Cash Wallet; IBEX is the ledger; no parallel Flash-side USDT wallet. (2) **Promoted ENG-297 from Phase 2 post-launch to Phase 1 / W1 launch blocker** (Olaniran). (3) Filed **ENG-345/346 (opt-in)** (Ben server half + Nick mobile half, W1) — per-user permanent non-reversible opt-in state machine `legacy_usd → opt_in_pending → eth_usdt_ready → eth_usdt_active`. (4) Filed **ENG-348** (Olaniran or Dread, W2) — audit-row writer for every Bridge↔IBEX USDT movement (not a wallet ledger). (5) Filed **ENG-357** (Olaniran+Ben, W4) — source-wallet switch for opted-in JM users (USDT → USD swap before JMD off-ramp). (6) Filed **ENG-347** (Dread+Nick, W1) — Flash-maintained country allowlist superset of the Bridge 86-country list. (7) Expanded ENG-275 scope to cover deposit-side push in addition to withdrawal completion. (8) Renumbered ENG-298 from Phase 3 → Phase 2. (9) Added Cashout V1 "unchanged" contradiction flag to Dread's ongoing list for explicit product confirmation. |
