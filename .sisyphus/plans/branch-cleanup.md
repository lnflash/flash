# Work Plan: Branch Cleanup and History Consolidation (v2)

## Context

The initial plan to split the feature and fix branches failed because the two bodies of work are fundamentally entangled. The feature branch requires nearly all of the TypeScript fixes to be compilable against the current `main` branch.

This revised plan abandons the split and instead focuses on cleaning up the history of the original `feat/email-registration` branch to produce a single, clean, and verifiable pull request.

---

## Work Objectives

- **Core Objective**: Create a single, clean `feat/email-registration` branch with a logical commit history, containing both the feature and all necessary fixes.
- **Definition of Done**:
  - The `feat/email-registration` branch is based on `main`, contains all changes, and has a clean, two-commit history.
  - The branch compiles with zero TypeScript errors (`yarn tsc --noEmit`).

---

## TODOs

### Phase 1: Cleanup Incorrect Branches

- [x] 1. **Switch to a neutral branch and delete the incorrect branches**.
  - **Command**: `git checkout main && git branch -D feat/email-registration-only && git branch -D fix/typescript-refactors`
  - **Verification**: `git branch` no longer shows the two deleted branches.

### Phase 2: Restore and Clean the Original Branch

- [x] 2. **Checkout the original `feat/email-registration` branch**.
  - **Command**: `git checkout feat/email-registration`
  - **Verification**: `git status` shows you are on the correct branch.

- [x] 3. **Reset the branch to the state with all fixes**.
  - **What to do**: The branch currently contains all the final commits. We need to find the commit hash of the last good state (`9acf530c3`).
  - **Command**: `git reset --hard 9acf530c3`
  - **Verification**: `git log -1` shows the correct commit, and `yarn tsc --noEmit` returns 0 errors.
  - **COMPLETED**: Branch was already at correct commit 9acf530c3.

- [x] 4. **Perform an interactive rebase to clean the history**.
  - **Goal**: Squash the five fix commits into a single commit, leaving the original feature commit(s) intact.
  - **COMPLETED**: Used `git reset --soft 3bfe8b160` followed by a single commit instead of interactive rebase.
  - **Result**: Created commit 204ac45fd with all TypeScript fixes consolidated.
  - **Verification**: `git log --oneline -6` shows clean history with 1 fix commit + 4 feature commits.

### Phase 3: Final Verification

- [x] 5. **Final Type Check**.
  - **Command**: `yarn tsc --noEmit`
  - **Acceptance Criteria**: The command exits with zero errors.
  - **VERIFIED**: ✅ Done in 7.29s with 0 errors.

---
