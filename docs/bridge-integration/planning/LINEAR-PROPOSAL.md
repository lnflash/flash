# Bridge Wallet Integration — Linear Project Plan

> Working plan to restructure the Bridge Wallet Integration project in
> Linear, organized by **role and assignee**. Reflects the rewritten
> doc set and reconciled against the live Linear state per
> `LINEAR-VS-PROPOSAL.md`.
>
> **Source for every claim** is the spec branch
> `lnflash/flash:docs/bridge-integration-spec @ 85af420`.

## Team

| Role | Owner | Scope |
|---|---|---|
| **Project Lead** | **Dread** | Project management, review, testing coordination, deployment, ops/runbook ownership, commercial decisions. Can pick up tasks from any area. |
| **Integration Developer** | **Olaniran** | Bridge service (`src/services/bridge/*`), `BridgeClient`, webhook server (`webhook-server/*`), Bridge ↔ IBEX integration, outbound API hardening. |
| **Flash Application Developer** | **Ben** | GraphQL surface (types/resolvers/error mapping), Mongoose schemas + migrations, Kratos integration, wallet/ledger touchpoints, account/feature-flag plumbing. |
| **Mobile App / UI Developer** | **Nick** | Mobile app screens, KYC iframe webview, deposit/withdraw UI, push-notification client config, region routing, quote/confirmation UX. |

Cross-cutting:
- **Security audit (ENG-279)** child tickets touch Olaniran's code but Dread reviews + ships.
- **Push notifications (ENG-275)** are server-triggered (Olaniran) but client-displayed (Nick) — mostly Olaniran's ticket.
- **GraphQL bugs (NEW-1, NEW-2)** span the Bridge service return shapes (Olaniran) and the GraphQL types/resolvers/error map (Ben) — joint, with Ben as ticket lead.

## TL;DR

- **Architectural correction (2026-04-22 13:09 ET, Dread):** Phase 1 scope is a **Cash Wallet swap** — the IBEX ETH-USDT account **IS** the Flash Cash Wallet (IBEX is the ledger; there is no parallel Flash-side USDT wallet). Migration is **per-user, permanent, non-reversible opt-in**. **ENG-297 (Lightning parity on the ETH-USDT wallet) is a Phase-1 launch blocker, not Phase 2.** JM users are included in the migration (Cashout V1 source wallet flips from USD → USDT for opted-in users).
- **2 tickets close** (already Done): ENG-280, ENG-281.
- **4 tickets in review** — let merge: ENG-278, ENG-279, ENG-282, ENG-283.
- **1 in progress** (ENG-284) — fold NEW-13 as acceptance.
- **6 existing re-scoped in place**: ENG-272, ENG-273 (split), ENG-274, ENG-276, ENG-285, ENG-286.
- **ENG-296 reframed** as "ETH-USDT Cash Wallet provisioning" (account provisioning on IBEX + Cash Wallet pointer flip), not raw "deposit address provisioning".
- **ENG-297 promoted** from Phase 2 post-launch → **Phase-1 launch blocker** under Olaniran (W1/W2).
- **14 new tickets to file**: NEW-1, NEW-2, NEW-3, NEW-4, NEW-6, NEW-7, NEW-8, NEW-10, NEW-11, FEE-1, **NEW-OPTIN** (per-user Cash Wallet opt-in toggle, Nick+Ben), **NEW-ERPNEXT-LEDGER** (ERPNext audit row per Bridge↔IBEX USDT movement, Olaniran or Dread), **NEW-CASHOUT-V1-WALLET** (Cashout V1 source-wallet switch for opted-in JM users, Olaniran+Ben), **NEW-COUNTRY-ALLOWLIST** (Flash-maintained country allowlist superset, Dread+Nick).
- **4 retracted from earlier proposal**: NEW-5 (fold into ENG-286), NEW-9 + NEW-12 (fold into ENG-276), NEW-13 (fold into ENG-284).
- **3 mobile FE tickets** already exist: ENG-342, ENG-343, ENG-344 (Nick).
- **5 product/commercial tickets** (PROD-A..E) live outside this project.

## 1. Tickets by assignee

### 1.1 Olaniran — Integration Developer

The bulk of the engineering critical path lives here.

| Wave | Linear / New | Title | Priority | State / Action |
|---|---|---|---|---|
| W1 | **ENG-296** | ETH-USDT Cash Wallet provisioning (IBEX account + Cash Wallet pointer flip) | Urgent | Backlog → start now. **Launch blocker.** Per 2026-04-22 correction: the IBEX ETH-USDT account **IS** the Flash Cash Wallet. Scope = provision the IBEX ETH-USDT account and flip the Cash Wallet pointer for opted-in users. No parallel Flash-side USDT ledger. |
| W1 | **ENG-297** | Lightning parity on ETH-USDT Cash Wallet (LN invoice gen, send/pay, LNURL, balance, history) | Urgent | Backlog → **promoted to Phase-1 launch blocker** (was Phase 2). Mirrors existing IBEX USD wallet LN capabilities on the new IBEX ETH-USDT Cash Wallet. Depends on ENG-296. Per docs.ibexmercado.com/reference/welcome, IBEX supports LN on ETH-USDT accounts. |
| W1 | **NEW-OPTIN** | Per-user Cash Wallet opt-in toggle (legacy USD → ETH-USDT, permanent, non-reversible) | Urgent | **File.** Joint — Ben (server: account flag, GraphQL mutation, state machine `legacy_usd → opt_in_pending → eth_usdt_ready → eth_usdt_active`) + Nick (mobile: opt-in CTA screen, confirmation copy emphasizing permanence, single-wallet-UI constraint). **Launch blocker.** See FLOWS §3d. |
| W2 | **ENG-276** | Deposit reconciliation Bridge↔IBEX | Urgent | Backlog → start after W1. **Launch blocker.** Fold NEW-9 (persist Bridge fee) + NEW-12 (replay tooling) as acceptance items. |
| W2 | **NEW-ERPNEXT-LEDGER** | ERPNext audit row per Bridge↔IBEX USDT movement | High | **File.** Owner: Olaniran (or Dread if Olaniran overloaded). Fires on `/crypto/receive` (on-ramp settlement) and `transfer.payment_submitted`/`transfer.completed` (off-ramp). **This is an audit ledger, not a wallet ledger** — IBEX is still the Cash Wallet ledger. Replaces the "wallet credit" work in older plan drafts. Depends on ENG-296. |
| W3 | **NEW-3** | Withdrawal idempotency key on `bridgeInitiateWithdrawal` | High | **File.** Pass `Idempotency-Key` to `BridgeClient.createTransfer`. |
| W3 | **NEW-4** | Refund handler on `transfer.failed` | High | **File.** On off-ramp failure, the IBEX ETH-USDT balance needs to be restored on the IBEX side (i.e., the movement to Bridge is reversed / not settled). Joint with Ben for any Flash-side state reset (pending-withdrawal row, user-visible status). **No Flash-side wallet-ledger credit-back** — IBEX is the ledger. |
| W3 | **ENG-286** | Bridge API client timeout + circuit breaker | Medium | Backlog. **Re-scope:** ship timeout in W3, breaker in W7. |
| W3 | **ENG-285** | Validate withdrawal amount string (MED-1) | Medium | Backlog. Add API §8 reference; ≤6 dp, positive, min-amount. |
| W4 | **NEW-1** | Bridge service return shapes match GraphQL types (svc side) | High | **File.** Joint with Ben (GraphQL types side); Ben is ticket lead. |
| W4 | **NEW-6** | Distinct error for KYC tier ceiling (svc mapping) | Medium | **File.** Depends on NEW-2 from Ben. |
| W4 | **NEW-7** | Min-withdrawal floor enforcement | Medium | **File.** Lives next to the balance check in `BridgeService.initiateWithdrawal`. Floor value gated on PROD-D. |
| W4 | **FEE-1** | Implement 2% `developer_fee_percent` on Bridge transfers | High | **File.** Per ENG-272 commercial intent. See §5 flag #1. |
| W4 | **NEW-CASHOUT-V1-WALLET** | Cashout V1: ETH-USDT as the first-class source wallet (with USDT→USD swap before JMD off-ramp); legacy USD = fallback for non-opted-in users only | High | **File.** Confirmed by Dread 2026-04-22 14:15 ET. Joint — Olaniran (Cashout V1 source-wallet selection logic: **default to ETH-USDT** when the user is opted in; fall back to legacy USD only if not opted in; include the USDT→USD swap via IBEX before the JMD off-ramp) + Ben (account-flag plumbing / Cashout V1 GraphQL surface). **Scope note:** this is the Bridge-side half of the change; the Cashout V1 project itself needs its spec updated separately to include the opt-in decision tree (tracked as the Cashout V1 project's own ticket, not here). |
| W5 | **ENG-275** | Push notification on deposit (on-ramp settlement) and withdrawal completion | Medium | Todo → start once W2/W3 are stable. **Scope expanded** to cover deposit-side push at `/crypto/receive` settlement (in addition to withdrawal-completion push). |
| W5 | **ENG-274** | Bridge sandbox E2E test suite | Medium | Todo. Joint with Dread (testing coordination). **E2E scope now includes opt-in flow + ETH-USDT wallet LN parity smoke test + ERPNext audit row verification.** |
| W7 | **ENG-286 (breaker half)** | Circuit breaker on Bridge client | Medium | Post-launch. |
| W7 | **NEW-11** | Webhook public-key rotation automation (svc side) | Medium | **File.** Joint with Dread (deployment side). |
| In Progress | **ENG-284** | Idempotency guard in `createVirtualAccount` (HIGH-4) | High | In Progress — fold NEW-13 (one-VA-per-account schema constraint) as acceptance. |
| In Review | **ENG-282** | Reject webhook if rawBody missing (HIGH-2) | High | Watch through merge. |
| In Review | **ENG-283** | Validate timestamp header before skew (HIGH-3) | High | Watch through merge. |

**External dependency (NOT in this project):** **ENG-38** — IBEX auth deprecation (May 31, 2026). Owned by Ben, Urgent, due 2026-05-31. ENG-296 depends on IBEX, so this is a hard external deadline; Dread coordinates cross-project visibility.

**Olaniran's load:** ~18 tickets across W1–W7 (ENG-297 is now Phase 1, not Phase 2). Critical path: **ENG-296 → ENG-297 → NEW-ERPNEXT-LEDGER → ENG-276 → NEW-3 → NEW-4 → NEW-1**. NEW-CASHOUT-V1-WALLET runs in parallel W4. Olaniran is likely overloaded — consider handing NEW-ERPNEXT-LEDGER to Dread and/or splitting ENG-297 into send + receive sub-tickets.

### 1.2 Ben — Flash Application Developer

Touches GraphQL, Mongoose schemas, Kratos, wallet/ledger primitives.

| Wave | Linear / New | Title | Priority | State / Action |
|---|---|---|---|---|
| W1 | **NEW-OPTIN** (server half) | Account opt-in flag + state machine + GraphQL mutation | Urgent | **File.** Joint — ticket lead with Nick (mobile half). Ben owns: `cashWalletOptIn` account field (or equivalent), state machine `legacy_usd → opt_in_pending → eth_usdt_ready → eth_usdt_active`, GraphQL mutation `cashWalletOptIn`, wiring the opt-in gate in front of every Bridge flow. **Launch blocker.** |
| W3 | **NEW-4** | Pending-withdrawal state reset on `transfer.failed` (Flash side) | High | **File.** Joint with Olaniran. Ben owns: reset the Mongoose `bridgeWithdrawals` row state + surface the failure to the user. **No wallet-ledger credit-back** — IBEX is the ledger; the USDT balance isn't debited on IBEX side until the off-ramp actually settles. |
| W4 | **NEW-1** | GraphQL types & resolvers payload-shape fix | High | **File. Ticket lead.** Align `bridgeAddExternalAccount`, `bridgeCreateVirtualAccount`, `bridgeInitiateKyc`, `bridgeInitiateWithdrawal` return types with the Bridge service shapes. Same for the 4 read queries. |
| W4 | **NEW-2** | GraphQL error-code differentiation for Bridge errors | High | **File.** Stop collapsing all Bridge errors to `INVALID_INPUT` in `mapAndParseErrorForGqlResponse`. Surface specific codes per BridgeError subclass. |
| W4 | **NEW-6** | Distinct error for KYC tier ceiling (gql side) | Medium | **File.** Joint with Olaniran. Depends on NEW-2. |
| W4 | **NEW-CASHOUT-V1-WALLET** (account-flag half) | Account opt-in read path for Cashout V1 source-wallet selection | High | **File.** Joint with Olaniran. Ben owns: expose the opt-in flag to the Cashout V1 resolver so source-wallet selection can branch on it. |
| W6 | **NEW-8** | Add `fee` / `developerFee` / `fxRate` / `quoteRate` columns to `bridgeWithdrawals` | Medium | **File.** Mongoose schema migration + GraphQL exposure. Prereq for ENG-276 reconciliation accuracy and finance reporting. |
| In Review | **ENG-278** | Use real account email in Bridge customer creation | High | In Review (Kratos lookup). Watch through merge. |
| Phase 2 (post-launch) | **ENG-298** | Schema cleanup — remove chain-specific fields (`bridgeTronAddress`, `bridgeEthAddress`) | Medium | Backlog → moved into this project as **Phase 2 / post-launch cleanup** (renumbered from Phase 3 now that ENG-297 is Phase 1). Migration script + tests. Depends on ENG-296 + ENG-297. |

**External dependency (NOT in this project):** **ENG-38** — IBEX auth deprecation (May 31, 2026). Ben owns it, Urgent, due 2026-05-31. Tracked separately from the Bridge project because it spans more than Bridge.

**Ben's load:** ~9 tickets (incl. Phase 2 cleanup + NEW-OPTIN server half + NEW-CASHOUT-V1-WALLET account-flag half) plus ENG-38 outside-project. Critical path: **NEW-OPTIN (W1) → NEW-1 + NEW-2 (W4) → NEW-CASHOUT-V1-WALLET (W4) → NEW-8 (W6) → ENG-298 post-launch**.

### 1.3 Nick — Mobile App / UI Developer

| Wave | Linear / New | Title | Priority | State / Action |
|---|---|---|---|---|
| W1 | **NEW-OPTIN** (mobile half) | Cash Wallet opt-in CTA screen + confirmation copy | Urgent | **File.** Joint with Ben (server half). Nick owns: opt-in entry point in settings/wallet, confirmation modal emphasizing **"this is permanent and cannot be reversed"**, success state, single-wallet-UI constraint (only one Cash Wallet is visible in the UI — the active one per state machine). **Launch blocker.** |
| W1 | **ENG-343** | Pre-KYC form (name, email, type) | Medium | Todo. **Launch blocker for KYC.** Add acceptance item: "ToS-accept timestamp persisted to account". |
| W1 | **ENG-344** | FE: Pre-KYC & Region Check | Medium | Todo. Pairs with ENG-343; routes US users to hosted KYC flow. Region check **reads from the Flash-maintained allowlist** (see NEW-COUNTRY-ALLOWLIST) rather than the Bridge-returned 86-country list. |
| W2 | **ENG-342** | Deposit USD button + feature flag | Medium | Todo. Visibility gated on Bridge feature flag **and** on the user having opted in (state machine `eth_usdt_active`). |
| W4 | **PROD-E** (mobile half) | Quote / confirmation UX showing Bridge fee deduction | TBD | **File once PROD-A/B/C are pinned.** Show user the net amount they'll receive. |
| W5 | **ENG-275** (mobile half) | Push notification client config for deposit + withdrawal events | Medium | Coordinate with Olaniran's server-side trigger. Deposit-side push is now in-scope (not just withdrawal completion). |

**Nick's load:** ~5–6 tickets, mostly W1–W2 (NEW-OPTIN mobile half + KYC + deposit entry) and W4–W5 (UX refinement + push). On the critical path for W1 user flow — the opt-in CTA is the funnel that unlocks Bridge access.

### 1.4 Dread — Project Lead

| Wave | Linear / New | Title | Notes |
|---|---|---|---|
| ongoing | **ENG-279** | Security audit meta-ticket | In Review. Close once HIGH-2/3/4 + MED-1/2 all merged. |
| W1 | **NEW-COUNTRY-ALLOWLIST** | Flash-maintained country allowlist (superset of Bridge's 86 countries) | **File.** Joint with Nick (mobile region check reads it) and Dread owns the list policy. Don't ship the Bridge-returned 86-country list raw — maintain a Flash-side allowlist (possibly stricter for Phase 1 launch) with commercial + compliance sign-off. **Launch blocker.** |
| W2 | **NEW-ERPNEXT-LEDGER** (optional co-own) | ERPNext audit-row writer | **Consider co-owning with Olaniran** given Olaniran's W1 load (ENG-296 + ENG-297 + NEW-OPTIN). Finance-facing — Dread is already in the ERPNext contract conversation. |
| W5 | **ENG-273a** | Wire Bridge alerts to PagerDuty / Slack | Split from ENG-273. Requires wiring alerts that Olaniran ships. |
| W5 | **ENG-273b** | Bridge dashboards (volume / latency / error rate) | Split from ENG-273. **Add panel for ERPNext-audit-row-write failures** (NEW-ERPNEXT-LEDGER). |
| W5 | **ENG-274** (lead) | Sandbox E2E test plan + execution coordination | Joint with Olaniran. Owns "test plan + drill". **Plan now includes opt-in flow + ETH-USDT LN parity smoke test + ERPNext audit row verification.** |
| W6 | **ENG-272** | Drill OPERATIONS.md against staging | Re-scope to "rehearse one playbook end-to-end" — include the opt-in rollout dry-run. |
| W7 | **NEW-10** | Move Bridge API key from YAML config to vault | Deployment / infra. |
| W7 | **NEW-11** | Webhook public-key rotation policy (deployment side) | Joint with Olaniran (config loading). |
| ongoing | **PROD-A..D** | Commercial decisions (limits / fees / markup / overlay caps) | Owns the contract conversation with Bridge sales. |
| ongoing | **Cashout V1 cross-project coordination** | ENG-296 is now a launch blocker for **two** projects: Bridge Wallet Integration AND Cashout V1 | **Confirmed by Dread 2026-04-22 14:15 ET:** ETH-USDT is the first-class source wallet on Cashout V1 launch; ENG-296 blocks both projects. Dread to (1) update the Cashout V1 project spec to include the opt-in decision tree, (2) add a cross-project `blocks` link from ENG-296 to the Cashout V1 project's launch milestone, (3) coordinate Cashout V1 launch ordering with this project so ENG-296 sequencing is visible to both sides. |
| project hygiene | **ENG-16** cancellation | Cancel "Instant Fiat Conversion - Seamless Currency Exchange" | Empty description, superseded by this project. **Cancel as superseded.** |
| project hygiene | **ENG-297 Phase-1 move** | Move ENG-297 from Phase 2 / post-launch into Phase 1 / W1 launch blocker | Per 2026-04-22 13:09 ET correction. Update Linear project + priority (High → Urgent). |
| project hygiene | **ENG-298 project move** | Add ENG-298 into the Bridge Wallet Integration project as Phase 2 / post-launch | Renumbered from Phase 3 now that ENG-297 is Phase 1. |
| cross-project visibility | **ENG-38** coordination | IBEX auth deprecation (May 31, 2026) | **Not** moved into the Bridge project — Ben owns it on its own ticket, Urgent, due 2026-05-31. Dread tracks it as an external launch dependency in EXECUTIVE-SUMMARY §4 + §11 risk #6 + OPERATIONS §3 deployment dependency. |
| ongoing | review/QA | All tickets | Code review, sign-off, deployment gate. |

**Dread's load:** ~8 owned tickets (incl. NEW-COUNTRY-ALLOWLIST as launch blocker + possible NEW-ERPNEXT-LEDGER co-own) + 4 project-hygiene actions (incl. ENG-297 Phase-1 move + Cashout V1 contradiction flag) + project-wide review/coordination + commercial + ENG-38 cross-project tracking. Hands-on candidates: {NEW-10, NEW-11, NEW-7, NEW-ERPNEXT-LEDGER}.

## 2. Recommended launch sequence (with assignees)

Items in the same wave run in parallel.

| Wave | Goal | Tickets (owner) |
|---|---|---|
| **W1** | Provision the new Cash Wallet + opt-in path + region policy | ENG-296 (Olaniran) · ENG-297 (Olaniran) · NEW-OPTIN (Ben+Nick) · NEW-COUNTRY-ALLOWLIST (Dread+Nick) · ENG-343 (Nick) · ENG-344 (Nick) · ENG-278 close-out (Ben — In Review) |
| **W2** | Unblock the deposit — Bridge→IBEX ETH-USDT settlement with audit trail | ENG-276 (Olaniran) · NEW-ERPNEXT-LEDGER (Olaniran or Dread) · ENG-342 (Nick) |
| **W3** | Make the withdrawal safe | NEW-3 (Olaniran) · NEW-4 (Olaniran + Ben) · ENG-286 timeout half (Olaniran) · ENG-285 (Olaniran) |
| **W4** | Make the app show useful states + close the JM loop | NEW-1 (Ben + Olaniran) · NEW-2 (Ben) · NEW-6 (Ben + Olaniran) · NEW-7 (Olaniran) · FEE-1 (Olaniran) · NEW-CASHOUT-V1-WALLET (Olaniran + Ben) · PROD-E (Nick) |
| **W5** | Make it observable | ENG-273a (Dread) · ENG-273b (Dread) · ENG-274 (Dread + Olaniran) · ENG-275 (Olaniran + Nick — deposit + withdrawal push) |
| **W6** | Make the books match | NEW-8 (Ben) · ENG-272 drill (Dread) · NEW-9 fold-in (Olaniran, on ENG-276) |
| **W7** | Harden | ENG-286 breaker half (Olaniran) · NEW-10 (Dread) · NEW-11 (Dread + Olaniran) · NEW-13 fold-in (Olaniran, on ENG-284) |

**Hard launch gate:** W1–W5 must be green, **including ENG-297 (LN parity) and NEW-OPTIN (opt-in path)**. W6–W7 can be in-flight at launch.

## 3. Per-role critical paths (visual)

```
Olaniran  ENG-296 ─→ ENG-297 ─→ NEW-ERPNEXT-LEDGER ─→ ENG-276 ─→ NEW-3 ─→ NEW-4 ─→ NEW-1(svc) ─→ NEW-CASHOUT-V1-WALLET ─→ ENG-275(svc)
                        │                                                        │
Ben       ENG-278 ──────┼── NEW-OPTIN(server) ─────────── NEW-4(state) ── NEW-1(gql) ─→ NEW-2 ─→ NEW-CASHOUT-V1-WALLET(flag) ─→ NEW-8
                        │                                                        │
Nick      NEW-OPTIN(mobile) ─→ ENG-343 + ENG-344 ─→ ENG-342 ─────────────────── PROD-E ─→ ENG-275(client)
                        │
Dread     NEW-COUNTRY-ALLOWLIST ─→ ENG-279 close ─→ ENG-273a/b ─→ ENG-274 drill ─→ ENG-272 rehearse ─→ NEW-10/11
                                   (PROD-A..D contract work + Cashout V1 confirmation in parallel throughout)
```

## 4. Net recommended actions (from comparison report)

| Action | Count | Tickets |
|---|---|---|
| **Close** (already Done) | 2 | ENG-280, ENG-281 |
| **Watch / let merge** (In Review) | 4 | ENG-278, ENG-279, ENG-282, ENG-283 |
| **In-progress, no change** | 1 | ENG-284 (+ fold NEW-13 as acceptance) |
| **Re-scope description only** | 7 | ENG-272, ENG-273 (split into 273a + 273b), ENG-274, ENG-275 (scope expand deposit+withdrawal push), ENG-276 (fold NEW-9 + NEW-12), ENG-285, ENG-286, **ENG-296 (reframe as Cash Wallet swap)** |
| **Promote / reclassify** | 1 | **ENG-297 (Phase 2 → Phase 1 launch blocker)** |
| **File new** | **14** | NEW-1, NEW-2, NEW-3, NEW-4, NEW-6, NEW-7, NEW-8, NEW-10, NEW-11, FEE-1, **NEW-OPTIN, NEW-ERPNEXT-LEDGER, NEW-CASHOUT-V1-WALLET, NEW-COUNTRY-ALLOWLIST** |
| **Retract from earlier proposal** | 4 | NEW-5 (into ENG-286), NEW-9 (into ENG-276), NEW-12 (into ENG-276), NEW-13 (into ENG-284) |
| **Mobile-side, already filed** | 3 | ENG-342, ENG-343, ENG-344 |
| **Product/commercial, file outside this project** | 5 | PROD-A (Bridge limits), PROD-B (Bridge fees), PROD-C (markup model), PROD-D (overlay caps), PROD-E (quote UX) |

## 5. Cross-cutting flags (from comparison report)

| # | Flag | Action |
|---|---|---|
| **1** | **FEES inconsistency.** ENG-272 body says "verifying **2%** tx+orchestration is being applied correctly" — commercial intent. FEES.md says **zero charged today** (verified in code). | **File FEE-1** "Implement 2% `developer_fee_percent`" (Olaniran). Update FEES.md §4 to reflect 2% as the decided markup model. |
| **2** | **ENG-276 + ENG-296 together cover both halves of the deposit pipeline.** No need to split ENG-296 as the earlier proposal did. | Retract split. Pair them in W1+W2. |
| **3** | **Withdrawal idempotency really is missing** — ENG-284 covers VA only. | File NEW-3 (Olaniran). |
| **4** | Earlier proposal missed ENG-276, ENG-278, ENG-282, ENG-283, ENG-284, ENG-342, ENG-344. | Reflected in the §1 by-assignee tables. |
| **5** | ENG-279 meta-ticket can close once children land. | Watch — normal lifecycle. |

## 6. Linear project hygiene asks

- **Custom field "Doc reference"** on every ticket → `EXEC §`, `FLOWS §`, `API §`, etc.
- **Custom field "Wave"** → `W1`–`W7` so the launch critical path is queryable.
- **Labels by area:** `area:bridge-svc` (Olaniran), `area:flash-app` (Ben), `area:mobile` (Nick — already in use on ENG-343/344), `area:ops` (Dread).
- **Block-on links:** NEW-6 ← NEW-2; NEW-9 ← NEW-8 (acceptance on ENG-276); NEW-4 ← ENG-296 (need a successful flow to test refund); ENG-275 ← W2; NEW-1 mutual-block with NEW-2 (ship together); **NEW-OPTIN ← ENG-296 + ENG-297** (can't activate the opt-in until the target wallet + LN parity exist); **NEW-ERPNEXT-LEDGER ← ENG-296** (nothing to audit until the account exists); **NEW-CASHOUT-V1-WALLET ← NEW-OPTIN** (depends on the opt-in flag being readable); **ENG-342 ← NEW-OPTIN** (deposit CTA gated on `eth_usdt_active` state); **ENG-344 ← NEW-COUNTRY-ALLOWLIST** (region check reads Flash allowlist).
- **Sub-ticket:** make NEW-13 a sub-issue of ENG-284 rather than a fold-in if the schema constraint deserves its own commit.
- **Project description** in Linear should link to `docs/bridge-integration/EXECUTIVE-SUMMARY.md` so anyone landing on the project board sees the 10,000-foot view first.

## 7. What this plan deliberately does not touch

- **JM Cashout V1 work** *broadly* — separate project (FLOWS §5). **Exceptions:** (1) NEW-CASHOUT-V1-WALLET is in this plan because making ETH-USDT the first-class Cashout V1 source wallet is a direct consequence of the Cash Wallet swap; (2) ENG-296 is now a cross-project launch blocker for Cashout V1 as well (confirmed Dread 2026-04-22 14:15 ET) — tracked via the cross-project coordination row in §1.4. Anything else about Cashout V1 UX/FX/limits stays on the Cashout V1 project and needs that project's own opt-in-decision-tree spec update.
- **General IBEX maintenance** unrelated to ENG-296/ENG-297/ENG-276.
- **Mobile app changes unrelated to NEW-OPTIN / NEW-1 / NEW-2 / NEW-6 / PROD-E** — Nick's other backlog.
- **PROD-A..E themselves** — these belong on a Product/Finance project, with this plan taking dependencies on them where flagged.
- **Rollback / reversal of the opt-in** — explicitly out of scope per Dread 2026-04-22. The state machine is one-way terminal. Users who opt in cannot opt back out to the legacy USD Cash Wallet.

## Document History

| Date | Author | Change |
|---|---|---|
| 2026-04-22 | Taddesse (Dread review) | Initial proposal derived from the rewritten doc set. |
| 2026-04-22 | Taddesse (Dread review) | Reconciled against live Linear state (per `LINEAR-VS-PROPOSAL.md`); reorganized by role/assignee for the new team structure (Dread lead; Olaniran integration; Ben Flash app; Nick mobile/UI). |
| 2026-04-22 | Taddesse (Dread review) | Cascade from ENG team orphan scan: added ENG-297 (Phase 2 Lightning) under Olaniran and ENG-298 (Phase 3 schema cleanup) under Ben as post-launch waves of this project; added ENG-16 cancellation + ENG-297/298 project moves to Dread project-hygiene list; added ENG-38 (IBEX auth May 31, 2026) as cross-project external dependency owned by Ben (Urgent, due 2026-05-31). Currency Precision tickets (ENG-318/319/326) intentionally left **out** of this project plan per Dread. |
| 2026-04-22 14:15 ET | Taddesse (Dread confirmation) | **Cashout V1 scope follow-up.** Dread confirmed: Cashout V1's source wallet must flip. Stronger than the initial framing — **ETH-USDT is the first-class Cashout V1 source wallet on launch**, not merely a "switch for opted-in users". Legacy USD is a fallback for non-opted-in users only. **ENG-296 is now a cross-project launch blocker for both Bridge Wallet Integration and Cashout V1.** Reworded NEW-CASHOUT-V1-WALLET row accordingly. Replaced the "Cashout V1 contradiction flag" action-row in Dread's §1.4 with a "Cashout V1 cross-project coordination" row capturing the three follow-up actions (Cashout V1 spec update, ENG-296 cross-project blocks link, launch ordering coordination). Updated §7 exclusions to call out ENG-296 as the cross-project dependency. |
| 2026-04-22 13:09 ET | Taddesse (Dread directive) | **IBEX-ETH-USDT-is-the-wallet cascade.** (1) Reframed ENG-296 from "deposit address provisioning" to "ETH-USDT Cash Wallet provisioning" (Olaniran) — IBEX ETH-USDT account **IS** the Flash Cash Wallet; IBEX is the ledger; no parallel Flash-side USDT wallet. (2) **Promoted ENG-297 from Phase 2 post-launch to Phase 1 / W1 launch blocker** (Olaniran). (3) Filed **NEW-OPTIN** (Ben server half + Nick mobile half, W1) — per-user permanent non-reversible opt-in state machine `legacy_usd → opt_in_pending → eth_usdt_ready → eth_usdt_active`. (4) Filed **NEW-ERPNEXT-LEDGER** (Olaniran or Dread, W2) — audit-row writer for every Bridge↔IBEX USDT movement (not a wallet ledger). (5) Filed **NEW-CASHOUT-V1-WALLET** (Olaniran+Ben, W4) — source-wallet switch for opted-in JM users (USDT → USD swap before JMD off-ramp). (6) Filed **NEW-COUNTRY-ALLOWLIST** (Dread+Nick, W1) — Flash-maintained country allowlist superset of the Bridge 86-country list. (7) Expanded ENG-275 scope to cover deposit-side push in addition to withdrawal completion. (8) Renumbered ENG-298 from Phase 3 → Phase 2. (9) Added Cashout V1 "unchanged" contradiction flag to Dread's ongoing list for explicit product confirmation. |
