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
| **Critical** — blocks Bridge launch if not handled | 1 | ENG-38 (IBEX auth deprecation, May 31 2026 deadline) |
| **Should be in the Bridge project** | 3 | ENG-295 (canceled parent), ENG-297 (Phase 2), ENG-298 (Phase 3) |
| **Likely stale / superseded — recommend cancel** | 1 | ENG-16 (Instant Fiat Conversion) |
| **Cross-link as dependency, don't move** | 4 | ENG-291 (account upgrade form bug), ENG-318 / ENG-319 / ENG-326 (Currency Precision project) |
| **Out of scope but adjacent (Cashout V1/V2)** | 3 | ENG-42, ENG-43, ENG-158 — leave alone |
| **False positives in keyword search** | ~30 | i18n, BTCMap, Lightning Address, WhatsApp Agent, etc. — no action |

## Section A — Critical external dependency

### **ENG-38 — IBEX auth deprecation deadline (May 31, 2026)**

| Field | Value |
|---|---|
| State | Todo |
| Priority | High |
| Project | (none) |
| Title | IBEX auth deprecation deadline (May 31, 2026) |
| URL | https://linear.app/island-bitcoin/issue/ENG-38 |

**Body:** "Track IBEX auth deprecation timeline and ensure Flash systems migrate before May 31, 2026."

**Why it matters for Bridge:** ENG-296 (the launch-blocking ETH USDT address provisioning) **depends on IBEX**. If Flash hasn't migrated to IBEX's M2M client-credentials auth by May 31, the Bridge integration breaks the moment IBEX revokes the old auth — about **5.5 weeks** from this report.

**Recommendation:**
- **Add ENG-38 to the Bridge Wallet Integration project** (or at minimum, add a `blocks` relation: ENG-38 → ENG-296).
- **Promote priority to Urgent.**
- **Assign to Olaniran** (he's already in the IBEX integration code) with Dread coordinating the migration deadline.
- Surface in EXECUTIVE-SUMMARY.md §4 blockers and in §11 risk register as risk #6.

## Section B — Tickets that belong in this project

These three are the **"Phase 1 / 2 / 3" split** of the original ENG-295 epic. ENG-296 (Phase 1) is in the project; the other three are not.

### **ENG-295 — Full IBEX wallet parity replacement** (Canceled — properly split)

| Field | Value |
|---|---|
| State | **Canceled** |
| Priority | High |
| Project | (none) |
| Title | feat(bridge): Full IBEX wallet parity replacement — ETH USDT wallet surface with extensible deposit address system |

Body opens with "⚠️ Superseded — split into ENG-296, ENG-297, ENG-298." Already correctly canceled.

**Recommendation:** Move into the Bridge Wallet Integration project as Canceled, or leave as-is. Either way no engineering work; just visibility.

### **ENG-297 — [Phase 2] Lightning parity on ETH USDT wallet**

| Field | Value |
|---|---|
| State | Backlog |
| Priority | High |
| Project | (none) |
| Depends on | ENG-296 |

Scope: Lightning invoice generation, send/pay LN invoices, LNURL, balance display, transaction history, webhook crediting on the ETH USDT wallet. Mirrors the existing IBEX USD wallet capabilities for the Bridge ETH USDT wallet.

**Recommendation:**
- **Add to Bridge Wallet Integration project** (Phase 2 / **out of Phase-1 launch scope**).
- **Assign to Olaniran** (continuation of ENG-296 code).
- Add `blocks-on` link to ENG-296.
- Tag with custom field `Wave: P2` (separate from W1–W7 which are Phase-1 launch waves).

### **ENG-298 — [Phase 3] Schema cleanup — remove chain-specific fields**

| Field | Value |
|---|---|
| State | Backlog |
| Priority | Medium |
| Project | (none) |
| Depends on | ENG-296 + ENG-297 |

Scope: remove `bridgeTronAddress`, `bridgeEthAddress` and other chain-specific fields from Account; migration script; full unit tests.

**Recommendation:**
- **Add to Bridge Wallet Integration project** (Phase 3, post-launch cleanup).
- **Assign to Ben** (Flash app schema is his domain).
- Add `blocks-on` ENG-297.
- Tag `Wave: P3`.

## Section C — Likely stale / recommend cancellation

### **ENG-16 — Instant Fiat Conversion - Seamless Currency Exchange**

| Field | Value |
|---|---|
| State | Backlog |
| Priority | High |
| Project | Core Wallet Features |
| Description | **(empty)** |
| Last touched | (check in Linear) |

Title-only ticket. Bridge Wallet Integration **is** the implementation of "instant fiat conversion" for Flash. With no description and no apparent owner activity, this is almost certainly orphaned/superseded.

**Recommendation:**
- **Cancel** as superseded by the Bridge Wallet Integration project, OR
- **Re-scope** with a description tying it explicitly to the Bridge integration (less work to delete it than re-scope).
- Confirm with whoever originally filed it.

## Section D — Cross-link as dependency (don't move)

### **ENG-291 — [Bug] Account Upgrade Form: HTTP 400 on Step 4 (ID Document Upload)**

| Field | Value |
|---|---|
| State | In Progress |
| Priority | **Urgent** |
| Project | v0.5.1 bugfixes |

Currently In Progress in v0.5.1 bugfixes — blocks all Personal → Pro / Pro → Merchant upgrades on Android v0.5.0.70.

**Why it matters for Bridge:** Every Bridge operation requires `account.level >= 2`. If this upgrade form is broken, **no new user can reach the level required to use Bridge.** ENG-344 (FE: Pre-KYC & Region Check) routes US users to hosted KYC for Bridge KYC specifically, but the **prior account-level upgrade still happens through this form** (per current understanding of the flow).

**Recommendation:**
- **Add `blocks` relation:** ENG-291 → all Bridge tickets that require level-2 (effectively, the launch).
- **Verify with Nick** whether US users on the Bridge path actually traverse this form, or whether ENG-344 lets them bypass it. If they bypass entirely, downgrade the dependency.
- Stays in v0.5.1 bugfixes project — don't move.

### **ENG-318 / ENG-319 / ENG-326 — Currency Precision project (Phase 1.2, 1.3, 3.1)**

| Field | Tickets | Highlight |
|---|---|---|
| ENG-318 | RoundingPolicy module | In Review, High |
| ENG-319 | price-server multi-source aggregator | Backlog, High |
| ENG-326 | Migrate send/receive mutations to `MoneyAmount` | Backlog, High |

**Why it matters for Bridge:** The float-precision concern in **ENG-285 (validate withdrawal amount string)** is solving the same class of problem — the Currency Precision project introduces a `MoneyAmount` scalar that, once landed, would be the right place to express withdrawal amounts safely. The two efforts shouldn't diverge.

**Recommendation:**
- Add `related` link from **ENG-285 → ENG-318/ENG-326**.
- **Decision needed:** Does Bridge withdrawal amount handling adopt `MoneyAmount` now (depending on Currency Precision Phase 3) or ship the local fix in ENG-285 and migrate later? Recommend **local fix now, migrate when Phase 3 lands** to avoid blocking launch on a different project.
- No project-membership change.

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

## Recommended actions consolidated

| Action | Tickets | Owner |
|---|---|---|
| **Move into project** (3) | ENG-295 (Canceled, visibility), ENG-297 (Phase 2), ENG-298 (Phase 3) | Dread |
| **Promote priority + add `blocks` to ENG-296** (1) | ENG-38 (IBEX auth) | Dread → Olaniran |
| **Cancel as superseded** (1) | ENG-16 (Instant Fiat Conversion) | Dread (after confirming with original filer) |
| **Add `blocks` relation, verify scope** (1) | ENG-291 → Bridge launch | Dread + Nick |
| **Add `related` link** (3) | ENG-285 ↔ ENG-318 / ENG-326 | Olaniran |
| **No action** | All Section E + F tickets | — |

## Updates to other planning docs implied by this scan

- **EXECUTIVE-SUMMARY.md §4** "What does not work yet (blockers)" — add row for **ENG-38 (IBEX auth deprecation, May 31)** as cross-cutting external deadline.
- **EXECUTIVE-SUMMARY.md §11** risk register — add risk #6: "IBEX auth deprecation date (May 31, 2026) cuts the rail if not migrated; Bridge depends on IBEX."
- **LINEAR-PROPOSAL.md §1.1 Olaniran** — add **ENG-38** to W1 as a precondition for ENG-296.
- **LINEAR-PROPOSAL.md §1.4 Dread** — add **ENG-16 cancellation** + **ENG-295 / 297 / 298 project moves** as project-hygiene items.
- **OPERATIONS.md §3** — note IBEX migration as a deployment dependency.

## Document History

| Date | Author | Change |
|---|---|---|
| 2026-04-22 | Taddesse (Dread review) | Initial scan of ENG team for Bridge-related orphans. Found 1 critical external dependency (ENG-38), 3 to move into project (ENG-295/297/298), 1 likely stale (ENG-16), 4 to cross-link (ENG-291, ENG-318, ENG-319, ENG-326). |
