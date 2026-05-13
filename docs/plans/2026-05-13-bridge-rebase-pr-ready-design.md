# Bridge Rebase PR-Ready Design

## Goal
Prepare the rebased Bridge integration branch for review by making the history Linear-scoped, applying only intentional cleanup, and verifying branch-owned changes without expanding lint scope to unrelated code.

## Constraints
- Every commit in the PR history must reference at least one Linear issue key.
- If multiple commits belong to one Linear issue, squash them unless separation materially improves reviewability.
- Do not lint code that this branch did not change or create.
- Preserve the current rebased branch as a safety point.
- Do not import the broad ForgeMini scratch formatting/dependency churn; cherry-pick only intentional fixes.

## Approach
Work from a new safety branch, reset the index against `origin/main`, and recommit the branch diff into Linear-scoped slices. Use existing Bridge Linear issues for core feature, security-audit fixes, reconciliation/replay tooling, account wallet creation, and PR-readiness cleanup. After history rewrite, apply the proven Bridge unit/idempotency fix selectively and verify build/unit/focused tests plus scoped lint only on files changed by the branch.

## Commit grouping
- `ENG-297`: core Bridge parity/integration surface and docs that support the launch path.
- `ENG-276`: deposit reconciliation and replay/backfill tooling.
- `ENG-348`: ERPNext audit-row writer support, if present in the diff.
- `ENG-376`: webhook/request idempotency hardening and retry-safety fixes.
- `ENG-394`: ETH-USDT Cash Wallet creation for raw account creation.
- Existing audit issues (`ENG-278`, `ENG-280`, `ENG-281`, `ENG-282`, `ENG-283`, `ENG-284`, `ENG-285`, `ENG-349`, `ENG-363`, etc.) stay mapped in commit messages where their changes are separable.

## Verification
- `yarn build`
- full unit suite if available in this worktree
- focused Bridge unit suites
- typecheck, with baseline failures documented separately if reproduced on `origin/main`
- scoped ESLint only for branch-created or branch-modified files, never unrelated files
- SDL diff check and commit regenerated schema/supergraph output only when branch-owned changes require it
