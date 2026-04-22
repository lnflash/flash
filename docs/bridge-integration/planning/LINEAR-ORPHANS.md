# Bridge-Related Linear Orphans & Stale Tickets

> Scan of the entire **ENG team backlog** for Bridge-related tickets that
> are **not** in the Bridge Wallet Integration project. Done as
> two-pass keyword search (round 1: bridge/tron/persona/usdt/kyc/etc.;
> round 2: bridge.xyz / BridgeClient / BridgeService / IBEX / fiat /
> ramp / etc.) followed by manual triage.
>
> Scope: ENG team only. Date: 2026-04-22.
> Total ENG tickets matching round 1+2 keywords: ~47. After de-dup and
> false-positive removal, **9 are actually relevant** (3 needing project
> moves, 1 critical external deadline, 1 likely stale, 4 cross-link
> only).

## TL;DR

| Severity | Count | Tickets |
|---|---|---|
| **Critical external dependency** — owned outside this project | 1 | **ENG-38** (IBEX auth deprecation, May 31 2026 deadline). Updated in Linear: assignee Ben, **Urgent**, due **2026-05-31**. Tracked outside the Bridge project. |
| **Moved into the Bridge Wallet Integration project** | 2 | **ENG-297** (Phase 2 Lightning parity), **ENG-298** (Phase 3 schema cleanup). Verified non-duplicate of any NEW-* / FEE-1 ticket. |
| **Canceled as superseded** | 1 | **ENG-16** (Instant Fiat Conversion — empty body, superseded by Bridge integration). |
| **No-op / parent already canceled** | 1 | ENG-295 — parent epic, already Canceled and properly split into ENG-296/297/298. Left alone. |
| **Already completed and deployed** | 1 | **ENG-291** (account upgrade form bug). Confirmed by Dread as completed and deployed; **no longer a Bridge launch blocker**. |
| **Out of scope but adjacent (Cashout V1/V2)** | 3 | ENG-42, ENG-43, ENG-158 — leave alone |
| **Out of this project plan** (separate effort) | — | **Currency Precision project (ENG-318/319/326)** — intentionally **not** taken as a dependency for this project per Dread. Bridge withdrawal amount handling stays local (ENG-285) and may migrate to `MoneyAmount` later if/when that project ships. No cross-link recorded here. |
| **False positives in keyword search** | ~30 | i18n, BTCMap, Lightning Address, WhatsApp Agent, etc. — no action |

## Section A — Critical external dependency

### **ENG-38 — IBEX auth deprecation deadline (May 31, 2026)** — *resolved, tracked externally*

| Field | Value (after update) |
|---|---|
| State | Todo |
| Priority | **Urgent** |
| Assignee | **Ben** |
| Due date | **2026-05-31** |
| Project | (none — intentionally outside the Bridge project) |
| URL | https://linear.app/island-bitcoin/issue/ENG-38 |

**Body:** "Track IBEX auth deprecation timeline and ensure Flash systems migrate before May 31, 2026."

**Why it matters for Bridge:** ENG-296 (the launch-blocking ETH USDT address provisioning) **depends on IBEX**. If Flash hasn't migrated to IBEX's M2M client-credentials auth by May 31, the Bridge integration breaks the moment IBEX revokes the old auth.

**Decision (Dread):** Do **not** move ENG-38 into the Bridge Wallet Integration project. Ben already owns the migration and is aware. Keep the ticket in its own home; Dread coordinates cross-project visibility.

**Cascade applied to docs:**
- `EXECUTIVE-SUMMARY.md §4` — added as cross-cutting external dependency in the blockers table.
- `EXECUTIVE-SUMMARY.md §11` — added as risk #6.
- `LINEAR-PROPOSAL.md §1.1` (Olaniran) and `§1.4` (Dread) — noted as external dependency, not in project.
- `OPERATIONS.md §3` — added as deployment dependency.

## Section B — Tickets moved into this project

These are the **"Phase 1 / 2 / 3" split** of the original ENG-295 epic. ENG-296 (Phase 1) was already in the project; ENG-297 and ENG-298 are now being added as Phase 2 and Phase 3 of this same project. Verified non-duplicate of any NEW-1..NEW-11 / FEE-1 ticket — all NEW tickets are Phase-1 scope.

### **ENG-295 — Full IBEX wallet parity replacement** (Canceled — already properly split)

| Field | Value |
|---|---|
| State | **Canceled** |
| Priority | High |
| Project | (none) |
| Title | feat(bridge): Full IBEX wallet parity replacement — ETH USDT wallet surface with extensible deposit address system |

Body opens with "⚠️ Superseded — split into ENG-296, ENG-297, ENG-298." Already correctly canceled.

**Decision:** Leave as-is. No engineering action.

### **ENG-297 — [Phase 2] Lightning parity on ETH USDT wallet** — *moving into project*

| Field | Value |
|---|---|
| State | Backlog |
| Priority | High |
| Project (target) | Bridge Wallet Integration |
| Depends on | ENG-296 |
| Suggested assignee | **Olaniran** (continuation of ENG-296 code) |
| Wave tag | **P2** (post-launch; separate from W1–W7 launch waves) |

Scope: Lightning invoice generation, send/pay LN invoices, LNURL, balance display, transaction history, webhook crediting on the ETH USDT wallet. Mirrors the existing IBEX USD wallet capabilities for the Bridge ETH USDT wallet.

**Action:** Add to Bridge Wallet Integration project via Linear `issueUpdate { projectId }` mutation. Add `blocks-on` link to ENG-296. Reflected in `LINEAR-PROPOSAL.md §1.1` Olaniran row "Phase 2".

### **ENG-298 — [Phase 3] Schema cleanup — remove chain-specific fields** — *moving into project*

| Field | Value |
|---|---|
| State | Backlog |
| Priority | Medium |
| Project (target) | Bridge Wallet Integration |
| Depends on | ENG-296 + ENG-297 |
| Suggested assignee | **Ben** (Flash app schema is his domain) |
| Wave tag | **P3** (post-launch cleanup) |

Scope: remove `bridgeTronAddress`, `bridgeEthAddress` and other chain-specific fields from Account; migration script; full unit tests.

**Action:** Add to Bridge Wallet Integration project via Linear `issueUpdate { projectId }` mutation. Add `blocks-on` link to ENG-297. Reflected in `LINEAR-PROPOSAL.md §1.2` Ben row "Phase 3".

## Section C — Canceled as superseded

### **ENG-16 — Instant Fiat Conversion - Seamless Currency Exchange** — *canceling*

| Field | Value |
|---|---|
| State (target) | **Canceled** |
| Priority | High |
| Project | Core Wallet Features |
| Description | **(empty)** |

Title-only ticket. Bridge Wallet Integration **is** the implementation of "instant fiat conversion" for Flash.

**Decision (Dread):** Cancel as superseded by the Bridge Wallet Integration project.

**Action:** Set state to Canceled via Linear `issueUpdate { stateId }` mutation (workflow state "Canceled" on the ENG team).

## Section D — Already resolved

### **ENG-291 — [Bug] Account Upgrade Form: HTTP 400 on Step 4 (ID Document Upload)** — *resolved*

| Field | Value |
|---|---|
| State | **Done / deployed** (per Dread) |
| Priority | Urgent (was) |
| Project | v0.5.1 bugfixes |

**Status (Dread, 2026-04-22):** ENG-291 has been **completed and deployed**. It is no longer a Bridge launch blocker. The level-2 upgrade path is healthy. **No action required** and no cross-link to file.

## Section D.1 — Out of this project plan

### Currency Precision project (ENG-318 / ENG-319 / ENG-326)

**Decision (Dread, 2026-04-22):** Leave the Currency Precision project entirely **out** of the Bridge Wallet Integration plan. No `related` links, no dependency tracking from this project.

Bridge withdrawal amount handling stays local (ENG-285). If/when Currency Precision lands a `MoneyAmount` scalar later, migration can be evaluated then on its own merits — it is **not** a precondition for Bridge launch and is not a tracked dependency here.

## Section E — Out of scope but adjacent (no action)

| Ticket | State | Project | Why mentioned |
|---|---|---|---|
| ENG-42 | Duplicate | Cashout V1 | JMD ERPNext customer import — Cashout is explicitly out of Bridge scope per FLOWS §6. |
| ENG-43 | Backlog | Cashout V2 | RTGS automation — same. |
| ENG-158 | Todo | Cashout V1 | Cashout transaction history — same. |

These are correctly outside the Bridge Wallet Integration project. Leaving them alone is the right call.

## Section F — False positives (~30 tickets)

Search hit but **no real Bridge relation** (matched on substring noise like "ACH" inside "approach", "fiat" in unrelated contexts, "bridge" as a metaphor, "persona" as personality, etc.):

ENG-1, ENG-40, ENG-54, ENG-124, ENG-136, ENG-137, ENG-161, ENG-162, ENG-163, ENG-164, ENG-166, ENG-186, ENG-189, ENG-190, ENG-195, ENG-218, ENG-219, ENG-220, ENG-225, ENG-238, ENG-241, ENG-242, ENG-244, ENG-245, ENG-251, ENG-266, ENG-267, ENG-270, ENG-287, ENG-290, ENG-305, ENG-321, ENG-323

No action needed.

## Recommended actions consolidated (after Dread review)

| Action | Tickets | Owner | Status |
|---|---|---|---|
| **Move into project** (2) | ENG-297 (Phase 2), ENG-298 (Phase 3) | Dread | Pending — Linear `issueUpdate { projectId }`. Verified non-duplicate of any NEW-* / FEE-1. |
| **Cancel as superseded** (1) | ENG-16 (Instant Fiat Conversion) | Dread | Pending — Linear `issueUpdate { stateId }`. |
| **Update + leave outside project** (1) | ENG-38 (IBEX auth) | Ben | **Done** — Linear: assignee Ben, Urgent, due 2026-05-31. |
| **No action** | ENG-291 (already deployed), ENG-295 (already canceled), Currency Precision (out of plan), Section E + F | — | — |

## Cascade applied to other planning docs

- ✅ **EXECUTIVE-SUMMARY.md §4** — added ENG-38 (IBEX auth, May 31, Ben, Urgent) as cross-cutting external dependency in the blockers table.
- ✅ **EXECUTIVE-SUMMARY.md §11** — added risk #6: IBEX auth deprecation cuts the crypto rail if not migrated.
- ✅ **LINEAR-PROPOSAL.md §1.1 Olaniran** — added ENG-297 (Phase 2 / post-launch) and external-dependency note for ENG-38.
- ✅ **LINEAR-PROPOSAL.md §1.2 Ben** — added ENG-298 (Phase 3 / post-launch) and external-dependency note for ENG-38.
- ✅ **LINEAR-PROPOSAL.md §1.4 Dread** — added ENG-16 cancellation, ENG-297 + ENG-298 project moves, and ENG-38 cross-project visibility as project-hygiene items.
- ✅ **OPERATIONS.md §3** — added IBEX migration as an external deployment dependency.
- ❌ **No** Currency Precision references added anywhere in the project plan, per Dread.

## Document History

| Date | Author | Change |
|---|---|---|
| 2026-04-22 | Taddesse (Dread review) | Initial scan of ENG team for Bridge-related orphans. Found 1 critical external dependency (ENG-38), 3 to move into project (ENG-295/297/298), 1 likely stale (ENG-16), 4 to cross-link (ENG-291, ENG-318, ENG-319, ENG-326). |
| 2026-04-22 | Taddesse (Dread review) | Applied Dread decisions: ENG-38 updated in Linear (Ben, Urgent, due 2026-05-31) and intentionally **not** moved into the Bridge project; ENG-297 + ENG-298 to be moved into project (verified non-duplicate of NEW-*); ENG-16 to be canceled; ENG-291 confirmed already completed and deployed (no longer a blocker, no cross-link); Currency Precision (ENG-318/319/326) intentionally **left out** of this project plan. ENG-295 left as-is (already canceled). Section D speculation about ENG-344 routing dropped. |
