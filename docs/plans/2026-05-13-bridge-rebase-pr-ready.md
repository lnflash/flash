# Bridge Rebase PR-Ready Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the rebased Bridge integration branch PR-ready with Linear-scoped commits and scoped verification.

**Architecture:** Preserve the completed rebase as a safety point, then use a cleanup branch to rewrite the diff into issue-scoped commits. Apply only targeted fixes from scratch worktrees and verify branch-owned behavior without linting unrelated code.

**Tech Stack:** TypeScript, GraphQL, Jest, Yarn, Git, Linear issue keys, Bridge.xyz integration code.

---

### Task 1: Create safety branch and planning docs

**Files:**
- Create: `docs/plans/2026-05-13-bridge-rebase-pr-ready-design.md`
- Create: `docs/plans/2026-05-13-bridge-rebase-pr-ready.md`

**Step 1:** Switch to a cleanup branch at current rebased HEAD.

Run: `git switch -c tmp/bridge-rebase-pr-ready`
Expected: branch points to the rebased candidate HEAD.

**Step 2:** Add the design and implementation plan docs.

Run: `git status --short`
Expected: only the two new docs are untracked.

**Step 3:** Commit with a Linear key.

Run: `git add docs/plans && git commit -m "ENG-297 docs: document Bridge rebase PR-readiness plan"`
Expected: commit succeeds and includes only plan docs.

### Task 2: Rewrite existing branch history into Linear-scoped commits

**Files:**
- Modify: all files in the current `origin/main..HEAD` diff.

**Step 1:** Capture current HEAD.

Run: `git branch safety/bridge-rebase-before-history-rewrite HEAD`
Expected: safety ref exists.

**Step 2:** Soft reset to `origin/main`.

Run: `git reset --soft origin/main && git restore --staged .`
Expected: full branch diff is unstaged working tree changes.

**Step 3:** Stage and commit logical groups.

Use path-based staging and `git add -p` where needed. Each commit message must start with or include a Linear issue key.

Expected commit groups:
- `ENG-297 feat(bridge): add core Bridge parity integration`
- `ENG-276 feat(bridge): add reconciliation and replay tooling`
- `ENG-348 feat(bridge): add ERPNext audit rows for Bridge movements`
- `ENG-376 fix(bridge): harden Bridge request idempotency`
- `ENG-394 feat(accounts): create ETH-USDT Cash Wallet for new accounts`
- Audit fixes mapped to their issue keys where separable.

**Step 4:** Verify all commits have Linear keys.

Run: `git log --format='%h %s' origin/main..HEAD | awk '!/ENG-[0-9]+|OPS-[0-9]+|COM-[0-9]+/ {print}'`
Expected: no output.

### Task 3: Apply targeted Bridge unit/idempotency fix

**Files:**
- Modify: `src/services/bridge/index.ts`
- Modify: `test/flash/unit/services/bridge/index.spec.ts`

**Step 1:** Cherry-pick only intentional hunks from ForgeMini scratch worktree.

Expected changes:
- Mock `@services/ibex/client` in Bridge service unit test.
- Before creating a new withdrawal row, call `BridgeAccountsRepo.findPendingWithdrawalWithoutTransfer(accountId, externalAccountId, amount)`.
- Reuse an existing pending withdrawal row to derive the same idempotency key on retry.

**Step 2:** Run focused test.

Run: `yarn jest test/flash/unit/services/bridge/index.spec.ts --runInBand`
Expected: Bridge service unit suite passes.

**Step 3:** Commit.

Run: `git add src/services/bridge/index.ts test/flash/unit/services/bridge/index.spec.ts && git commit -m "ENG-376 fix(bridge): reuse pending withdrawal idempotency rows"`
Expected: commit succeeds.

### Task 4: Verify PR readiness without unrelated lint

**Files:**
- Test/build commands operate on the branch.
- Lint command must be limited to files changed by `origin/main..HEAD`.

**Step 1:** Run build.

Run: `yarn build`
Expected: pass, or document branch-independent baseline failure.

**Step 2:** Run focused Bridge tests.

Run: focused Jest commands for Bridge service/client/webhook suites.
Expected: pass.

**Step 3:** Run full unit suite if dependencies are present.

Run: repository unit test command.
Expected: pass, or document failing suites with ownership.

**Step 4:** Run scoped lint only on branch-owned files.

Run: construct changed-file list with `git diff --name-only origin/main...HEAD` and pass only supported TS/JS files to ESLint.
Expected: no branch-owned lint failures, or documented remaining branch-owned fixes.

**Step 5:** Check SDL/schema drift.

Run: repository SDL generation/check command.
Expected: either clean, or commit required generated schema artifacts with the relevant ENG key.

### Task 5: Prepare PR branch

**Step 1:** Show final summary.

Run: `git status --short --branch`, `git log --oneline origin/main..HEAD`, and `git diff --shortstat origin/main...HEAD`.
Expected: clean worktree and Linear-scoped commits.

**Step 2:** Push only after explicit approval if force-updating `feature/bridge-integration`.

Run when approved: `git push --force-with-lease origin HEAD:feature/bridge-integration`
Expected: remote branch updates safely.
