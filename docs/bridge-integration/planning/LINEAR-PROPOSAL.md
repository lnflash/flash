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

- **2 tickets close** (already Done): ENG-280, ENG-281.
- **4 tickets in review** — let merge: ENG-278, ENG-279, ENG-282, ENG-283.
- **1 in progress** (ENG-284) — fold NEW-13 as acceptance.
- **6 existing re-scoped in place**: ENG-272, ENG-273 (split), ENG-274, ENG-276, ENG-285, ENG-286.
- **10 new tickets to file**: NEW-1, NEW-2, NEW-3, NEW-4, NEW-6, NEW-7, NEW-8, NEW-10, NEW-11, plus FEE-1 ("Implement 2% `developer_fee_percent`" — see §5 flag #1).
- **4 retracted from earlier proposal**: NEW-5 (fold into ENG-286), NEW-9 + NEW-12 (fold into ENG-276), NEW-13 (fold into ENG-284).
- **3 mobile FE tickets** already exist: ENG-342, ENG-343, ENG-344 (Nick).
- **5 product/commercial tickets** (PROD-A..E) live outside this project.

## 1. Tickets by assignee

### 1.1 Olaniran — Integration Developer

The bulk of the engineering critical path lives here.

| Wave | Linear / New | Title | Priority | State / Action |
|---|---|---|---|---|
| W1 | **ENG-296** | ETH USDT deposit address provisioning | Urgent | Backlog → start now. **Launch blocker.** |
| W2 | **ENG-276** | Deposit reconciliation Bridge↔IBEX | Urgent | Backlog → start after W1. **Launch blocker.** Fold NEW-9 (persist Bridge fee) + NEW-12 (replay tooling) as acceptance items. |
| W3 | **NEW-3** | Withdrawal idempotency key on `bridgeInitiateWithdrawal` | High | **File.** Pass `Idempotency-Key` to `BridgeClient.createTransfer`. |
| W3 | **NEW-4** | Refund handler on `transfer.failed` | High | **File.** Credit USDT wallet back when an off-ramp fails. Joint with Ben (wallet credit primitive). |
| W3 | **ENG-286** | Bridge API client timeout + circuit breaker | Medium | Backlog. **Re-scope:** ship timeout in W3, breaker in W7. |
| W3 | **ENG-285** | Validate withdrawal amount string (MED-1) | Medium | Backlog. Add API §8 reference; ≤6 dp, positive, min-amount. |
| W4 | **NEW-1** | Bridge service return shapes match GraphQL types (svc side) | High | **File.** Joint with Ben (GraphQL types side); Ben is ticket lead. |
| W4 | **NEW-6** | Distinct error for KYC tier ceiling (svc mapping) | Medium | **File.** Depends on NEW-2 from Ben. |
| W4 | **NEW-7** | Min-withdrawal floor enforcement | Medium | **File.** Lives next to the balance check in `BridgeService.initiateWithdrawal`. Floor value gated on PROD-D. |
| W4 | **FEE-1** | Implement 2% `developer_fee_percent` on Bridge transfers | High | **File.** Per ENG-272 commercial intent. See §5 flag #1. |
| W5 | **ENG-275** | Push notification on withdrawal completion | Medium | Todo → start once W2/W3 are stable. |
| W5 | **ENG-274** | Bridge sandbox E2E test suite | Medium | Todo. Joint with Dread (testing coordination). |
| W7 | **ENG-286 (breaker half)** | Circuit breaker on Bridge client | Medium | Post-launch. |
| W7 | **NEW-11** | Webhook public-key rotation automation (svc side) | Medium | **File.** Joint with Dread (deployment side). |
| In Progress | **ENG-284** | Idempotency guard in `createVirtualAccount` (HIGH-4) | High | In Progress — fold NEW-13 (one-VA-per-account schema constraint) as acceptance. |
| In Review | **ENG-282** | Reject webhook if rawBody missing (HIGH-2) | High | Watch through merge. |
| In Review | **ENG-283** | Validate timestamp header before skew (HIGH-3) | High | Watch through merge. |
| Phase 2 (post-launch) | **ENG-297** | Lightning parity on ETH USDT wallet | High | Backlog → moved into this project as **Phase 2 / out of Phase-1 launch scope**. Mirrors the existing IBEX USD wallet capabilities (LN invoice gen, send/pay, LNURL, balance, history, webhook crediting) on the Bridge ETH USDT wallet. Depends on ENG-296. |

**External dependency (NOT in this project):** **ENG-38** — IBEX auth deprecation (May 31, 2026). Owned by Ben, Urgent, due 2026-05-31. ENG-296 depends on IBEX, so this is a hard external deadline; Dread coordinates cross-project visibility.

**Olaniran's load:** ~15 tickets across W1–W7 + Phase 2. Critical path: **ENG-296 → ENG-276 → NEW-3 → NEW-4 → NEW-1**. ENG-297 follows post-launch.

### 1.2 Ben — Flash Application Developer

Touches GraphQL, Mongoose schemas, Kratos, wallet/ledger primitives.

| Wave | Linear / New | Title | Priority | State / Action |
|---|---|---|---|---|
| W3 | **NEW-4** | Wallet refund primitive for `transfer.failed` (Flash side) | High | **File.** Joint with Olaniran. Ben owns the credit-back ledger entry. |
| W4 | **NEW-1** | GraphQL types & resolvers payload-shape fix | High | **File. Ticket lead.** Align `bridgeAddExternalAccount`, `bridgeCreateVirtualAccount`, `bridgeInitiateKyc`, `bridgeInitiateWithdrawal` return types with the Bridge service shapes. Same for the 4 read queries. |
| W4 | **NEW-2** | GraphQL error-code differentiation for Bridge errors | High | **File.** Stop collapsing all Bridge errors to `INVALID_INPUT` in `mapAndParseErrorForGqlResponse`. Surface specific codes per BridgeError subclass. |
| W4 | **NEW-6** | Distinct error for KYC tier ceiling (gql side) | Medium | **File.** Joint with Olaniran. Depends on NEW-2. |
| W6 | **NEW-8** | Add `fee` / `developerFee` / `fxRate` / `quoteRate` columns to `bridgeWithdrawals` | Medium | **File.** Mongoose schema migration + GraphQL exposure. Prereq for ENG-276 reconciliation accuracy and finance reporting. |
| In Review | **ENG-278** | Use real account email in Bridge customer creation | High | In Review (Kratos lookup). Watch through merge. |
| Phase 3 (post-launch) | **ENG-298** | Schema cleanup — remove chain-specific fields (`bridgeTronAddress`, `bridgeEthAddress`) | Medium | Backlog → moved into this project as **Phase 3 / post-launch cleanup**. Migration script + tests. Depends on ENG-296 + ENG-297. |

**External dependency (NOT in this project):** **ENG-38** — IBEX auth deprecation (May 31, 2026). Ben owns it, Urgent, due 2026-05-31. Tracked separately from the Bridge project because it spans more than Bridge.

**Ben's load:** ~7 tickets (incl. Phase 3) plus ENG-38 outside-project. Critical path: **NEW-1 + NEW-2** in W4 (both unblock the mobile UI), then schema work in W6, then ENG-298 post-launch.

### 1.3 Nick — Mobile App / UI Developer

| Wave | Linear / New | Title | Priority | State / Action |
|---|---|---|---|---|
| W1 | **ENG-343** | Pre-KYC form (name, email, type) | Medium | Todo. **Launch blocker for KYC.** Add acceptance item: "ToS-accept timestamp persisted to account". |
| W1 | **ENG-344** | FE: Pre-KYC & Region Check | Medium | Todo. Pairs with ENG-343; routes US users to hosted KYC flow. |
| W2 | **ENG-342** | Deposit USD button + feature flag | Medium | Todo. Visibility gated on Bridge feature flag. |
| W4 | **PROD-E** (mobile half) | Quote / confirmation UX showing Bridge fee deduction | TBD | **File once PROD-A/B/C are pinned.** Show user the net amount they'll receive. |
| W5 | **ENG-275** (mobile half) | Push notification client config for transfer events | Medium | Coordinate with Olaniran's server-side trigger. |

**Nick's load:** ~3–5 tickets, mostly W1–W2 (KYC + deposit entry) and W4–W5 (UX refinement + push). Light total but on the critical path for W1/W2 user flow.

### 1.4 Dread — Project Lead

| Wave | Linear / New | Title | Notes |
|---|---|---|---|
| ongoing | **ENG-279** | Security audit meta-ticket | In Review. Close once HIGH-2/3/4 + MED-1/2 all merged. |
| W5 | **ENG-273a** | Wire Bridge alerts to PagerDuty / Slack | Split from ENG-273. Requires wiring alerts that Olaniran ships. |
| W5 | **ENG-273b** | Bridge dashboards (volume / latency / error rate) | Split from ENG-273. |
| W5 | **ENG-274** (lead) | Sandbox E2E test plan + execution coordination | Joint with Olaniran. Owns "test plan + drill". |
| W6 | **ENG-272** | Drill OPERATIONS.md against staging | Re-scope to "rehearse one playbook end-to-end". |
| W7 | **NEW-10** | Move Bridge API key from YAML config to vault | Deployment / infra. |
| W7 | **NEW-11** | Webhook public-key rotation policy (deployment side) | Joint with Olaniran (config loading). |
| ongoing | **PROD-A..D** | Commercial decisions (limits / fees / markup / overlay caps) | Owns the contract conversation with Bridge sales. |
| project hygiene | **ENG-16** cancellation | Cancel "Instant Fiat Conversion - Seamless Currency Exchange" | Empty description, superseded by this project. **Cancel as superseded.** |
| project hygiene | **ENG-297 + ENG-298** project moves | Add Phase 2 (ENG-297) and Phase 3 (ENG-298) into the Bridge Wallet Integration project | Visibility for the post-launch waves so they don't drift. Verified non-duplicate of NEW-* / FEE-1 (NEW-* are all Phase-1 scope). |
| cross-project visibility | **ENG-38** coordination | IBEX auth deprecation (May 31, 2026) | **Not** moved into the Bridge project — Ben owns it on its own ticket, Urgent, due 2026-05-31. Dread tracks it as an external launch dependency in EXECUTIVE-SUMMARY §4 + §11 risk #6 + OPERATIONS §3 deployment dependency. |
| ongoing | review/QA | All tickets | Code review, sign-off, deployment gate. |

**Dread's load:** ~6 owned tickets + 3 project-hygiene actions + project-wide review/coordination + commercial + ENG-38 cross-project tracking. Suggest also picking up one of {NEW-10, NEW-11, NEW-7} for hands-on.

## 2. Recommended launch sequence (with assignees)

Items in the same wave run in parallel.

| Wave | Goal | Tickets (owner) |
|---|---|---|
| **W1** | Unblock the rail — user can KYC + get a virtual account | ENG-296 (Olaniran) · ENG-343 (Nick) · ENG-344 (Nick) · ENG-278 close-out (Ben — already In Review) |
| **W2** | Unblock the deposit — funds credit to wallet | ENG-276 (Olaniran) · ENG-342 (Nick) |
| **W3** | Make the withdrawal safe | NEW-3 (Olaniran) · NEW-4 (Olaniran + Ben) · ENG-286 timeout half (Olaniran) · ENG-285 (Olaniran) |
| **W4** | Make the app show useful states | NEW-1 (Ben + Olaniran) · NEW-2 (Ben) · NEW-6 (Ben + Olaniran) · NEW-7 (Olaniran) · FEE-1 (Olaniran) · PROD-E (Nick) |
| **W5** | Make it observable | ENG-273a (Dread) · ENG-273b (Dread) · ENG-274 (Dread + Olaniran) · ENG-275 (Olaniran + Nick) |
| **W6** | Make the books match | NEW-8 (Ben) · ENG-272 drill (Dread) · NEW-9 fold-in (Olaniran, on ENG-276) |
| **W7** | Harden | ENG-286 breaker half (Olaniran) · NEW-10 (Dread) · NEW-11 (Dread + Olaniran) · NEW-13 fold-in (Olaniran, on ENG-284) |

**Hard launch gate:** W1–W5 must be green. W6–W7 can be in-flight at launch.

## 3. Per-role critical paths (visual)

```
Olaniran  ENG-296 ─→ ENG-276 ─→ NEW-3 ─→ NEW-4 ─→ NEW-1(svc) ─→ ENG-275(svc) ─→ ENG-286(breaker)
                                  │                  │
Ben       ENG-278 ───────────────┼──── NEW-4(ledger) NEW-1(gql) ─→ NEW-2 ─→ NEW-8
                                  │
Nick      ENG-343 + ENG-344 ─→ ENG-342 ──────────────────→ PROD-E ─→ ENG-275(client)
                                  │
Dread     ENG-279 close ──────────┴──→ ENG-273a/b ─→ ENG-274 drill ─→ ENG-272 rehearse ─→ NEW-10/11
                                       (PROD-A..D contract work running in parallel throughout)
```

## 4. Net recommended actions (from comparison report)

| Action | Count | Tickets |
|---|---|---|
| **Close** (already Done) | 2 | ENG-280, ENG-281 |
| **Watch / let merge** (In Review) | 4 | ENG-278, ENG-279, ENG-282, ENG-283 |
| **In-progress, no change** | 1 | ENG-284 (+ fold NEW-13 as acceptance) |
| **Re-scope description only** | 6 | ENG-272, ENG-273 (split into 273a + 273b), ENG-274, ENG-276 (fold NEW-9 + NEW-12), ENG-285, ENG-286 |
| **File new** | **10** | NEW-1, NEW-2, NEW-3, NEW-4, NEW-6, NEW-7, NEW-8, NEW-10, NEW-11, FEE-1 |
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
- **Block-on links:** NEW-6 ← NEW-2; NEW-9 ← NEW-8 (acceptance on ENG-276); NEW-4 ← ENG-296 (need a successful flow to test refund); ENG-275 ← W2; NEW-1 mutual-block with NEW-2 (ship together).
- **Sub-ticket:** make NEW-13 a sub-issue of ENG-284 rather than a fold-in if the schema constraint deserves its own commit.
- **Project description** in Linear should link to `docs/bridge-integration/EXECUTIVE-SUMMARY.md` so anyone landing on the project board sees the 10,000-foot view first.

## 7. What this plan deliberately does not touch

- **JM Cashout V1 work** — separate project (FLOWS §6).
- **General IBEX maintenance** unrelated to ENG-296/ENG-276.
- **Mobile app changes unrelated to NEW-1/NEW-2/NEW-6/PROD-E** — Nick's other backlog.
- **PROD-A..E themselves** — these belong on a Product/Finance project, with this plan taking dependencies on them where flagged.

## Document History

| Date | Author | Change |
|---|---|---|
| 2026-04-22 | Taddesse (Dread review) | Initial proposal derived from the rewritten doc set. |
| 2026-04-22 | Taddesse (Dread review) | Reconciled against live Linear state (per `LINEAR-VS-PROPOSAL.md`); reorganized by role/assignee for the new team structure (Dread lead; Olaniran integration; Ben Flash app; Nick mobile/UI). |
| 2026-04-22 | Taddesse (Dread review) | Cascade from ENG team orphan scan: added ENG-297 (Phase 2 Lightning) under Olaniran and ENG-298 (Phase 3 schema cleanup) under Ben as post-launch waves of this project; added ENG-16 cancellation + ENG-297/298 project moves to Dread project-hygiene list; added ENG-38 (IBEX auth May 31, 2026) as cross-project external dependency owned by Ben (Urgent, due 2026-05-31). Currency Precision tickets (ENG-318/319/326) intentionally left **out** of this project plan per Dread. |
