# Bridge Integration — Session Context Save (2026-04-22)

> Saved per Dread 16:16 ET ("great work. lets close this out for now, save
> your context to a memory .md file somewhere"). This file captures the
> state of the Bridge Wallet Integration doc rewrite at end-of-day so the
> next session can resume cold.

## What this project is

A full rewrite of the Flash Bridge.xyz Wallet Integration doc set on
working branch `docs/bridge-integration-rewrite-2026-04-22` against spec
branch `lnflash/flash:docs/bridge-integration-spec @ 85af420`. The rewrite
is grounded in actual code at that ref — every claim should be traceable
to the spec branch.

The deliverable is the doc set under `/workspace/group/bridge-integration/`,
mirrored to the repo at `docs/bridge-integration/`.

## Working branch & cascade history

**Branch:** `docs/bridge-integration-rewrite-2026-04-22`
**Repo:** `lnflash/flash`
**HEAD as of session close:** `a25ff75` (cascade #10)

**Schedule landed (cascade #10, 21:18 ET):** All 37 open issues now carry due dates. **Code complete: Mon 2026-05-11.** **Launch: Fri 2026-05-22.** Slippage policy per Dread 21:16 ET — he's Ben's dev backup; anything else that slips → Dread takes the ticket. Full dated schedule in `planning/LINEAR-PROPOSAL.md` §2A.

| # | Commit | Date/Time ET | Summary |
|---|---|---|---|
| 1 | (initial) | 2026-04-21 | Full rewrite of doc set: ETH-only, four state machines, JM jurisdiction support, iframe-embed KYC, edge cases, alignment with `85af420`. |
| 2 | (early-day) | 2026-04-22 13:09 ET | **Architectural correction (Dread):** IBEX ETH-USDT account IS the Cash Wallet — no parallel Flash-side wallet ledger. Per-user permanent opt-in. ENG-297 (LN parity) promoted to Phase-1 launch blocker. Filed the opt-in pair (ENG-345 + ENG-346), ENG-348 (ERPNext audit), ENG-357 (Cashout V1 wallet), ENG-347 (country allowlist). JM users included in migration. |
| 3 | (mid-day) | 2026-04-22 14:15 ET | **Cashout V1 follow-up:** ETH-USDT is the **first-class** source wallet on Cashout V1 re-launch; legacy USD = fallback only. ENG-296 = cross-project launch blocker for both Bridge Integration and Cashout V1. |
| 4 | (mid-day) | 2026-04-22 14:29 ET + 14:52 ET | **Diagram modernization:** Replaced all ASCII-art diagrams with Mermaid (stateDiagram-v2 / sequenceDiagram with `link` directives / flowchart with `click`). Owner + ticket ID inline in node labels. Parse-error fix on §3 component diagram. |
| 5 | `e0317fa` | 2026-04-22 15:36 ET | **Olaniran load-shed + §5.2 direction fix + §3 ELI5.** Reassigned ENG-296 + ENG-297 + ENG-275-server to Ben; ENG-357 to Dread (lead) + Ben. Olaniran ~18→~13. Ben ~9→~13. Fixed §5.2 off-ramp direction (Bridge does not pull; Flash backend instructs IBEX to send USDT to `BRIDGE_TRANSFER_ETH_ADDR`). Added §3 ELI5 intro on state machines (board-game analogy). |
| 6 | `a626c71` | 2026-04-22 15:52 ET | **ENG-348 → Ben.** Audit writer sits on top of webhook handlers Ben now owns; consolidating avoids cross-engineer handoffs. Olaniran ~13→~12. Ben ~13→~14. Dread ~9→~8. Propagated across LINEAR-PROPOSAL, FLOWS, ARCHITECTURE, README, EXECUTIVE-SUMMARY. |
| 7 | `3d9e570` | 2026-04-22 16:30 ET | **Pre-Linear-mirror cleanup.** Stale owner refs in TL;DR + Nick §1.3; `[⚠ CRIT-PATH]` markers on Ben's W1/W2 four-pack; new §5A ticket-boundary discipline (ENG-351/352↔ENG-353↔ENG-354, ENG-276↔ENG-348, ENG-345/346↔ENG-357); ENG-273 → parent + 2 sub-issues; ENG-363 → sub-issue of ENG-284; §6 split into 6A required / 6B nice / 6C fallbacks; §2 W5 reframed as graduated gate. |
| 8 | `148da20` | 2026-04-22 18:30 ET | **Linear mirror executed + ID translation appendix.** Per Dread "go!" 18:11 ET. ~50 mutations against live Linear: 16 new tickets ENG-345→ENG-360, 3 sub-issues ENG-361/362/363, 8 reassignments, 4 priority bumps, 11 description rewrites, 2 title rewrites (ENG-296/297), 12 blocks relations, critical-path label on ENG-296/297/345/348, project description + content body. Doc-side: status banner + ID translation table at top of LINEAR-PROPOSAL.md mapping placeholder names → live ENG IDs. This file (SESSION-CONTEXT) refreshed with cascade #7 + #8 rows + ticket assignment lists updated to live Linear IDs. |
| 10 | `a25ff75` | 2026-04-22 21:18 ET | **Dated schedule applied to all 37 open issues.** Per Dread 21:02 ET ("put some due dates on all 37 open issues … aggressive goal of May 22nd with code complete on May 11th") + 21:16 ET approval. Built backwards from **code-complete = Mon 2026-05-11** + **launch = Fri 2026-05-22**, sliced into calendar waves W0–W5. All 37 dueDate mutations applied via Linear `issueUpdate` — 0 failures. Slippage policy: Dread is Ben's dev backup (informal); anyone else's slips → Dread takes the ticket (formal reassign). Doc-side: added §2A "Dated schedule" to LINEAR-PROPOSAL.md with five wave tables + load-check matrix + slippage policy + flagged risks. ENG-298 placed post-launch (May 29, Phase 2 schema cleanup — explicitly not launch-blocking). |
| 9 | `4f9fd48` | 2026-04-22 18:50 ET | **NEW-*/FEE-* placeholder scrub across all 10 docs.** Per Dread "we need to update all the docs so they no longer say NEW- on the issues" (18:39 ET). Two-pass mechanism: (a) bulk substring scrub with longest-prefix-first ordered table — 491 subs across 10 files with disambiguations for split tickets (NEW-OPTIN → ENG-345/346, NEW-1 → ENG-351/352) and inline labels for retracted tickets (NEW-5/9/12 folded into ENG-286/ENG-276 scope); (b) cleanup pass — 80 hand-targeted fixes for bulk-scrub artifacts (redundant `**ENG-345** (ENG-345 …)` patterns rewritten with descriptive labels; doubled `[retired → ENG-276 acceptance]` markers distinguished as Bridge-fee-persistence + replay-tooling; LINEAR-PROPOSAL self-referential ID-translation table reframed as "Historical placeholder map (cascade #8 → cascade #9)" Rosetta stone with backtick-quoted original placeholder names restored in leftmost column; multi-line wrapped `NEW-ERPNEXT-\nLEDGER` ASCII-diagram cells in WEBHOOKS.md replaced as compact ENG-348 labels). Residual `NEW-*` tokens are intentional — they survive only inside backtick-quoted historical-archaeology cells (the placeholder-map table + a few "former placeholder names from earlier drafts" callouts). Every inline / narrative reference now uses the live ENG ID. |

Cascade scripts live in `/tmp/work/push-*.mjs` (one per cascade — disposable, not reused). Pattern: GitHub Git Data API (blobs → tree → commit → PATCH ref), `GITHUB_TOKEN` env, parent = previous cascade head.

## Current ticket assignments (after cascade #8 — all placeholders now have live Linear IDs)

> Linear mirror landed cleanly 2026-04-22 18:11–18:30 ET. The
> Placeholder names from earlier drafts (`NEW-OPTIN`, `NEW-1`, etc.) have all been
> rewritten to live ENG IDs in cascade #9 (2026-04-22 18:45 ET).
> See the historical placeholder map at the top of `LINEAR-PROPOSAL.md`.

### Ben (~14 tickets — heaviest in project)

W1: **ENG-296** (ETH-USDT Cash Wallet provisioning, launch blocker, cross-project) · **ENG-297** (LN parity, launch blocker) · **ENG-345** (Cash Wallet opt-in: server — state machine + GraphQL mutation)
W2: **ENG-348** (ERPNext audit-row writer; reassigned 15:52 ET)
W3: **ENG-350** (pending-withdrawal state reset on transfer.failed; blocked by ENG-296)
W4: **ENG-351** (GraphQL payload-shape fix — gql half, lead) · **ENG-353** (GraphQL error-code differentiation, ships with ENG-351) · **ENG-354** (KYC-tier ceiling distinct error, blocked by ENG-353) · **ENG-357** (Cashout V1 source-wallet selection — Dread is lead; Ben holds the account-flag GraphQL surface)
W5: **ENG-275 server half** (deposit + withdrawal push trigger; reassigned 15:36 ET)
W6: **ENG-358** (schema migration for fee/fxRate columns; blocks ENG-276 fee persistence)
In Review: ENG-278
Phase 2: ENG-298

**External:** ENG-38 (IBEX auth deprecation, due 2026-05-31, Urgent) — outside this project but Ben owns it. Concentration of all IBEX touchpoints on Ben is intentional.

**Critical path (4 tickets — slipping any of these slips the launch):** ENG-296, ENG-297, ENG-345, ENG-348. All four carry the workspace `critical-path` label.

### Olaniran (~12 tickets — Bridge service / webhook server / outbound API only, no IBEX spine)

W2: **ENG-276** (deposit reconciliation Bridge↔IBEX, launch blocker, absorbs the former Bridge-fee-persistence + replay-tooling acceptance items; blocked by ENG-358 for fee columns)
W3: **ENG-349** (withdrawal idempotency key on bridgeInitiateWithdrawal) · **ENG-350** svc half (joint w/ Ben) · ENG-286 timeout half · ENG-285 (amount validation)
W4: **ENG-352** (Bridge service return-shape match — svc half, ships with Ben's ENG-351) · **ENG-355** (min-withdrawal floor enforcement) · **ENG-356** (2% developer_fee_percent on Bridge transfers)
W5: ENG-274 (joint w/ Dread)
W7: ENG-286 breaker half · ENG-360 server-side rotation tooling
In Progress: ENG-284 (parent of sub-issue **ENG-363** = one-VA-per-account Mongoose schema constraint)
In Review: ENG-282 · ENG-283

### Nick (~5–6 tickets)

W1: **ENG-346** (Cash Wallet opt-in: mobile — CTA + permanence-emphasizing confirm modal; blocked by ENG-345) · ENG-343 · ENG-344 (blocked by ENG-347)
W2: ENG-342 (deposit USD button, gated on `eth_usdt_active`; blocked by ENG-345)
W4: PROD-E (quote/confirmation UX)
W5: ENG-275 mobile half

### Dread (~8 owned tickets + project hygiene + commercial)

W1: **ENG-347** (Flash-maintained country allowlist — superset of Bridge 86; joint w/ Nick)
W4: **ENG-357** (Cashout V1 source-wallet selection — lead; cross-project coordination; blocked by ENG-345)
W5: **ENG-361** (sub-issue of ENG-273 — wire alerts to PagerDuty/Slack, must-have W5 launch gate) · **ENG-362** (sub-issue of ENG-273 — Bridge dashboards + ERPNext-audit-failure panel, strong should-have W5) · ENG-273 parent (closes when both children close) · ENG-274 lead (joint w/ Olaniran)
W6: ENG-272 (drill OPERATIONS.md against staging)
W7: **ENG-359** (Bridge API key → vault) · **ENG-360** (webhook public-key rotation deployment side)
Ongoing: ENG-279 close-out · ENG-298 caretaker (Phase-2 schema cleanup, reassigned 18:11 ET) · PROD-A..D commercial · Cashout V1 cross-project coordination · ERPNext contract counterpart (ENG-348 stays Ben-owned, Dread is contract-side) · **Linear cross-project blocks link from ENG-296 → Cashout V1 issue** (skipped in mirror per Dread "skip" decision — Dread sets manually in UI when target Cashout V1 ticket is identified)

Hands-on candidates if anything slips: {ENG-359, ENG-360, ENG-355}.

## Key architectural decisions (still load-bearing)

1. **IBEX ETH-USDT account IS the Flash Cash Wallet.** IBEX is the ledger. There is **no parallel Flash-side USDT wallet**. Webhooks drive **audit + push notification**, not bookkeeping. (Earlier "credit USDT wallet" framing was wrong.)

2. **Per-user permanent, non-reversible Cash Wallet opt-in.** State machine: `legacy_usd → opt_in_pending → eth_usdt_ready → eth_usdt_active`. Users who opt in **cannot opt back out**. Single-wallet UI (only one Cash Wallet visible per state).

3. **JM users are included in the migration.** Cashout V1's source wallet flips: ETH-USDT is first-class on Cashout V1 re-launch; legacy USD = fallback for non-opted-in users only. **ENG-296 is a cross-project launch blocker for Cashout V1 too.**

4. **§5.2 off-ramp funds direction (corrected 15:36 ET):** Bridge does **not** pull USDT. The flow is:
   - F → B: `POST /v0/transfers` → receive `deposit_instructions.address` (= `BRIDGE_TRANSFER_ETH_ADDR`)
   - F → I: instruct IBEX to send USDT from user's IBEX ETH-USDT account to that address (ENG-296 + ENG-297, owner Ben)
   - I → I: on-chain transfer
   - I → F: ack with tx hash for reconciliation (ENG-276)
   - B observes inbound USDT, swaps to USD, initiates ACH

5. **State machines (FLOWS §3):** five total — §3a KYC, §3b VirtualAccount, §3c Deposit (`ibex_received` terminal — no Flash-side credit), §3d Cash Wallet opt-in, §3e Withdrawal. ELI5 intro added at top of §3 (board-game analogy: squares = states, arrows = transitions, terminal = end; reasons = illegal-move detection, testability, race-condition survival).

6. **Two webhook servers.** Bridge webhook server (separate Express on `BridgeConfig.webhook.port` 4009) for `transfer.completed` etc. IBEX webhook server (existing) — Bridge integration adds `POST /crypto/receive` route. Neither writes a Flash-side wallet ledger.

## Doc set inventory

Under `/workspace/group/bridge-integration/`:

| File | Purpose |
|---|---|
| `README.md` | Index + Phase 1 scope + open work |
| `EXECUTIVE-SUMMARY.md` | 10,000-foot view — what works, what's missing, launch gaps, risks |
| `ARCHITECTURE.md` | Component diagram, four-service architecture, two-webhook deposit model, data model, security |
| `FLOWS.md` | State machines (§3) + sequences (§4 on-ramp, §5.1 EA linking, §5.2 withdrawal) + ticket maps |
| `WEBHOOKS.md` | Webhook handler reference |
| `OPERATIONS.md` | Runbooks, drills, on-call |
| `API.md` | GraphQL + Bridge REST surface |
| `FEES.md` | What's enforced today (zero) vs commercial intent (2% per ENG-356) |
| `LIMITS.md` | Bridge limits + Flash overlay caps |
| `SECURITY.md` | CRIT-1/2, HIGH-1..4, MED-1/2 audit findings |
| `planning/LINEAR-PROPOSAL.md` | Ticket-by-assignee plan, waves W1–W7, critical paths |
| `planning/LINEAR-VS-PROPOSAL.md` | Reconciliation against live Linear state |
| `planning/LINEAR-ORPHANS.md` | ENG tickets not in this project |

## Workflow notes

- **No PRs, no merges to main.** Pushes to the working branch are allowed (per Dread 12:35 ET).
- **One push script per cascade** in `/tmp/work/push-*.mjs`. Disposable. Don't reuse.
- **History rows** at the bottom of every changed doc — every cascade adds a dated row with author + change summary.
- **Diagram convention:** Mermaid only. Owner + ticket ID inline in node labels. `link`/`click` directives to Linear URLs. Use project-URL placeholders for any tickets not yet filed.
- **Mermaid pitfall:** unquoted parens inside pipe-edge labels break the parser (PS token error). Use `&mdash;` instead.

## Stale attributions still in FLOWS.md (not addressed this session)

While doing the cascade #5 cleanup I noticed FLOWS.md still has a couple of "Laurent" tags on ENG-275 in diagram node labels (lines ~239, 338) and `ARCHITECTURE.md` line 135 (§3 ticket table) and line 275 (§5.4 ticket table) — these are stale (ENG-275 server half is Ben; mobile half is Nick after 15:36 ET). **Not in any user directive yet, so left as-is.** Worth flagging to Dread if a future cascade touches those sections.

Other potentially stale tag in ARCHITECTURE.md: line 132 (ENG-296 owner: "Ben / Olaniran") — should be just "Ben" after 15:36 ET. Line 134 (ENG-273 owner: Nick) — but ENG-273 has been split into 273a/273b with Dread as lead per LINEAR-PROPOSAL.md §1.4. Leaving these as future-cleanup candidates.

## What I'd do next if Dread reopens this

1. **Stale-attribution sweep across ARCHITECTURE.md and FLOWS.md** for the items flagged above (Laurent → Ben/Nick on ENG-275; Ben/Olaniran → Ben on ENG-296; Nick → Dread on ENG-273). _Not addressed by cascade #8 — that one was doc → Linear, not doc internal cleanup._
2. ~~**File the placeholder tickets in Linear**~~ — **DONE cascade #8.** All 16 originally-placeholder tickets + 3 sub-issues now live as ENG-345→ENG-363. See historical placeholder map at top of `planning/LINEAR-PROPOSAL.md`.
3. **Dread manual UI step: cross-project blocks link from ENG-296 → Cashout V1 issue.** Skipped in the mirror per Dread "skip" decision (18:11 ET, Q3) — no specific Cashout V1 target was picked. When the target ticket is identified on the Cashout V1 project, add the relation in Linear UI.
4. **PROD-A..E commercial sign-off** — Bridge limits, fees, markup model, overlay caps, quote UX. Dread owns; flagged as a launch dependency in EXECUTIVE-SUMMARY §4 and §11 risks.
5. **ENG-38 deadline tracking** — IBEX auth deprecation due 2026-05-31. ~5 weeks out. Ben-owned but cross-project visibility is Dread's job.
6. **Walk Ben through the new IBEX-spine ownership** — he just inherited ENG-296 + ENG-297 + ENG-345 (opt-in server) + ENG-348 (ERPNext audit) + ENG-275-server + ENG-357 flag half on top of ENG-38. ~14 tickets is heaviest in the project; four of them carry `critical-path`.

## Reference: where to look first

- **What's the current ticket plan?** → `planning/LINEAR-PROPOSAL.md` §1 (by assignee), §2 (waves), §3 (critical paths)
- **What's the state-machine model?** → `FLOWS.md` §3 (with ELI5 intro)
- **What does the deposit flow look like end-to-end?** → `FLOWS.md` §4
- **What does the off-ramp / withdrawal flow look like?** → `FLOWS.md` §5.2 (corrected direction)
- **What's the audit story?** → ENG-348, owned by Ben; FLOWS §4 + §5.2 ticket maps + ARCHITECTURE §5.4
- **What's blocking launch?** → EXECUTIVE-SUMMARY §4 + LINEAR-PROPOSAL §2 W1 + FLOWS §9
- **Why is the Cash Wallet model what it is?** → ARCHITECTURE §1–§2 + FLOWS §3c + EXECUTIVE-SUMMARY §1 (post-13:09 ET correction)

---

_Last pushed cascade: `a25ff75` — dated schedule on all 37 open issues (21:18 ET, cascade #10)._
_Previous: `4f9fd48` — NEW-*/FEE-* placeholder scrub across all 10 docs (18:50 ET, cascade #9)._
_Session re-opened by Dread at 16:41 ET ("lets go ahead and update Linear now") and green-lit at 18:11 ET ("go!")._
