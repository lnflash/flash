# Linear × LINEAR-PROPOSAL.md — Comparison Report

> Reconciliation of the proposal in `LINEAR-PROPOSAL.md` against the
> real state of the **Bridge Wallet Integration** project in Linear as
> of 2026-04-22 10:15 ET. Source of truth for Linear state:
> https://linear.app/island-bitcoin/project/bridge-wallet-integration-a1596c3a2b6a
> (19 issues at time of read).

## Part A — Existing Linear tickets × Proposal

| Linear | State | Priority | Proposal said | Alignment | Recommended action |
|---|---|---|---|---|---|
| **ENG-272** Ops runbook | Todo | Low | Re-scope to "drill OPERATIONS.md against staging" | aligned | Update description to reference `docs/bridge-integration/OPERATIONS.md` + acceptance = one playbook rehearsed. **Note:** ticket body mentions "Fee reconciliation — verifying 2% tx+orchestration is being applied correctly" — see §C flag #1. |
| **ENG-273** Monitoring + alerting | Backlog | Medium | Split `273a wire-to-PagerDuty` + `273b dashboards` | aligned | Split as proposed. Current body already lists both alert + dashboard work. |
| **ENG-274** Sandbox E2E | Todo | Medium | Keep; block launch on it | aligned | Add "blocks launch" label / milestone. Body already lists the 3 flows I'd want exercised. |
| **ENG-275** Push notification on withdrawal | Todo | Medium | Keep; trivial after ENG-296 | aligned | No change. Body already points at the exact `// TODO` I flagged. |
| **ENG-276** Deposit reconciliation Bridge↔IBEX | Backlog | Urgent | **Not in proposal — missed** | gap in proposal | Keep. Overlaps with NEW-9 (persist Bridge fee from transfer response) and NEW-12 (backfill/replay). See §C flag #2 for de-dup. |
| **ENG-277** IBEX Tron USDT address | **Canceled** | High | Proposal assumes Tron pivoted away | aligned | No action. Confirms pivot. |
| **ENG-278** Real account email in Bridge customer creation | In Review | High | **Not in proposal — missed** | gap in proposal | Let it merge. Was always going to be needed; overlaps with ENG-343 pre-KYC scope. |
| **ENG-279** Security audit (meta) | In Review | High | Not referenced | neutral | No action. Parent for CRIT-1/2 + HIGH-2/3/4 + MED-1/2. |
| **ENG-280** USDT balance check (CRIT-1) | **Done** | High | Close | aligned | Already Done. No action. |
| **ENG-281** External account ownership compound index (CRIT-2) | **Done** | High | Close | aligned | Already Done. No action. |
| **ENG-282** Reject webhook if rawBody missing (HIGH-2) | In Review | High | **Not in proposal — missed** | gap in proposal | Let it merge. This is the `JSON.stringify` fallback bypass risk. Fold into SECURITY.md once merged. |
| **ENG-283** Validate timestamp header before skew (HIGH-3) | In Review | High | **Not in proposal — missed** | gap in proposal | Let it merge. `NaN` bypass of skew check. Fold into SECURITY.md §2 once merged. |
| **ENG-284** Idempotency in `createVirtualAccount` (HIGH-4) | In Progress | High | Partial overlap with NEW-3 | partial | Keep. ENG-284 is VA-creation only. NEW-3 is **withdrawal** idempotency — **still needed** as a separate ticket. See §C flag #3. |
| **ENG-285** Validate withdrawal amount string (MED-1) | Backlog | Medium | Re-scope around API §8 gaps | mostly aligned | Already targets the real concern (≤6 decimal places, positive, min). Add reference to API §8 in description. |
| **ENG-286** Timeout + circuit breaker (MED-2) | Backlog | Medium | Split timeout (NEW-5) from breaker | partial | **Re-scope in place** instead of splitting — ticket already lists both, just tag timeout as W3/launch-blocking and breaker as W7/post-launch. |
| **ENG-296** ETH USDT address provisioning | Backlog | **Urgent** | Split `296a provisioning` + `296b wallet credit` | partial | **Don't split.** ENG-276 (reconciliation) already covers the credit path. Leave ENG-296 = provisioning. See §C flag #2. |
| **ENG-342** FE: Deposit USD button + feature flag | Todo | Medium | **Not in proposal — missed** | gap in proposal | No action. Mobile-side ticket. |
| **ENG-343** FE: Pre-KYC form (name, email, type) | Todo | Medium | Keep; acceptance = name + ToS-accept captured | aligned | Add acceptance item "ToS-accept timestamp persisted to account" to description. |
| **ENG-344** FE: Pre-KYC & Region Check | Todo | Medium | **Not in proposal — missed** | gap in proposal | No action. Mobile routing ticket. |

## Part B — Proposal's new tickets × Linear

| Proposal | Title | In Linear? | Action |
|---|---|---|---|
| **NEW-1** | GraphQL payload-shape mismatches | not filed | **File.** P0, launch-blocking. |
| **NEW-2** | GraphQL error-code differentiation | not filed | **File.** P0, launch-blocking. |
| **NEW-3** | Withdrawal idempotency key | not filed (ENG-284 is VA-only) | **File.** P0. Mirror ENG-284's approach but on `initiateWithdrawal`. |
| **NEW-4** | Refund on `transfer.failed` | not filed | **File.** P0, money risk. |
| **NEW-5** | Outbound Bridge HTTP timeout | bundled into ENG-286 | **Don't file.** Re-scope ENG-286. |
| **NEW-6** | KYC tier distinct error | not filed | **File.** P1, depends on NEW-2. |
| **NEW-7** | Min-withdrawal floor | not filed | **File.** P1, product-gated. |
| **NEW-8** | Add fee/fxRate columns to `bridgeWithdrawals` | not filed | **File.** P1, schema. |
| **NEW-9** | Persist Bridge `fee` from `GET /transfers/:id` | overlaps ENG-276 | **Don't file separately.** Fold into ENG-276 acceptance. |
| **NEW-10** | Move Bridge API key to vault | not filed | **File.** P2, security. |
| **NEW-11** | Webhook key rotation policy | not filed | **File.** P2, security. |
| **NEW-12** | Backfill / replay tooling | overlaps ENG-276 | **Don't file separately.** Fold into ENG-276. |
| **NEW-13** | One-VA-per-account schema constraint | overlaps ENG-284 | **Fold into ENG-284** as acceptance. |

## Part C — Critical discrepancies flagged

| # | Flag | Action |
|---|---|---|
| **1** | **FEES inconsistency.** ENG-272 body says "verifying **2% tx+orchestration** is being applied correctly" — commercial intent to charge 2%. FEES.md says **zero charged today** (verified in code: `developer_fee_percent` is never set). Both are true — intent vs code. | **File new ticket:** "Implement 2% `developer_fee_percent` on Bridge transfers (per ENG-272)". Populate `developer_fee_percent` in `BridgeService.createVirtualAccount` / `initiateWithdrawal`. Update FEES.md §4 to reflect 2% as the decided markup model. |
| **2** | **ENG-276 already covers what the proposal's 296a/296b split was for.** ENG-296 = provisioning; ENG-276 = credit path + reconciliation. | **Retract split.** W2 = ENG-296 + ENG-276 together. |
| **3** | **Withdrawal idempotency really is missing.** ENG-284 covers VA creation only. `BridgeClient.createTransfer` supports `Idempotency-Key` that the service never passes. | **File NEW-3 as proposed.** |
| **4** | **Proposal missed 6 existing tickets** (ENG-276, ENG-278, ENG-282, ENG-283, ENG-284, ENG-342, ENG-344). | **Refresh launch sequence** to include: W1 adds ENG-343 + ENG-344; W2 adds ENG-276; W3 adds ENG-284. |
| **5** | ENG-279 meta-ticket "In Review" but its children are at mixed states. | No action — normal audit lifecycle. |

## Part D — Net recommended actions

| Action | Count | Tickets |
|---|---|---|
| **Close** (already Done) | 2 | ENG-280, ENG-281 |
| **Watch / let merge** (In Review) | 4 | ENG-278, ENG-279, ENG-282, ENG-283 |
| **In-progress, no change** | 1 | ENG-284 (+ fold NEW-13 as acceptance) |
| **Re-scope description only** | 6 | ENG-272, ENG-273 (split), ENG-274, ENG-276 (fold NEW-9 + NEW-12), ENG-285, ENG-286 |
| **File new** | **10** | NEW-1, NEW-2, NEW-3, NEW-4, NEW-6, NEW-7, NEW-8, NEW-10, NEW-11, + "Implement 2% developer_fee_percent" |
| **Retract from proposal** | 4 | NEW-5, NEW-9, NEW-12, NEW-13 |
| **Mobile-side, no action from this project** | 3 | ENG-342, ENG-343, ENG-344 |

## Document History

| Date | Author | Change |
|---|---|---|
| 2026-04-22 | Taddesse (Dread review) | Initial reconciliation of LINEAR-PROPOSAL.md against live Linear state (19 issues). |
