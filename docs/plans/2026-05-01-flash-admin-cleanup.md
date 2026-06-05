# Flash Admin Cleanup CLI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a repo-local TypeScript CLI for safe identity-layer cleanup with `lookup`, `plan`, and `apply` commands that humans and OpenClaw can both use.

**Architecture:** A thin CLI entrypoint in `dev/bin/flash-admin-cleanup.ts` delegates to a typed cleanup engine under `src/app/admin/identity-cleanup/`. The engine separates selector normalization, record lookup, exact-ID plan generation, apply execution, and post-delete verification so destructive operations remain auditable and idempotent.

**Tech Stack:** TypeScript, Node.js, yargs, existing Flash repositories/services, Ory Kratos admin client, Jest, existing repo build/test tooling.

---

### Task 1: Create shared types and artifact model

**Files:**
- Create: `src/app/admin/identity-cleanup/types.ts`
- Test: `test/flash/unit/app/admin/identity-cleanup/types.spec.ts`

**Step 1: Write the failing test**

Create a test that asserts the shared types can represent:
- selector input for `username`, `phone`, `email`, `kratosId`
- expanded candidate sets
- exact-ID delete plans
- apply results with deleted/alreadyAbsent/error buckets
- verification summaries

**Step 2: Run test to verify it fails**

Run: `yarn test:unit test/flash/unit/app/admin/identity-cleanup/types.spec.ts`
Expected: FAIL because the module does not exist yet.

**Step 3: Write minimal implementation**

Define exported interfaces and enums for:
- selector input
- normalized selector input
- lookup result
- cleanup plan
- apply result
- verification result
- artifact metadata

Keep them focused on v1 deletion scope only.

**Step 4: Run test to verify it passes**

Run: `yarn test:unit test/flash/unit/app/admin/identity-cleanup/types.spec.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add test/flash/unit/app/admin/identity-cleanup/types.spec.ts src/app/admin/identity-cleanup/types.ts
git commit -m "feat: add cleanup cli shared types"
```

### Task 2: Add selector normalization

**Files:**
- Create: `src/app/admin/identity-cleanup/normalize.ts`
- Test: `test/flash/unit/app/admin/identity-cleanup/normalize.spec.ts`

**Step 1: Write the failing test**

Create tests for:
- preserving exact usernames and kratos IDs
- normalizing phone input into canonical E.164 when possible
- accepting email as lowercase normalized value
- rejecting empty selector sets
- rejecting obviously invalid phone/email formats

**Step 2: Run test to verify it fails**

Run: `yarn test:unit test/flash/unit/app/admin/identity-cleanup/normalize.spec.ts`
Expected: FAIL because the module does not exist yet.

**Step 3: Write minimal implementation**

Use repo-native utilities where possible, plus `libphonenumber-js` if needed, to normalize selectors into a predictable structure consumed by lookup and plan creation.

**Step 4: Run test to verify it passes**

Run: `yarn test:unit test/flash/unit/app/admin/identity-cleanup/normalize.spec.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add test/flash/unit/app/admin/identity-cleanup/normalize.spec.ts src/app/admin/identity-cleanup/normalize.ts
git commit -m "feat: normalize cleanup cli selectors"
```

### Task 3: Implement lookup engine with repository adapters

**Files:**
- Create: `src/app/admin/identity-cleanup/lookup.ts`
- Modify: `src/app/admin/index.ts`
- Test: `test/flash/unit/app/admin/identity-cleanup/lookup.spec.ts`

**Step 1: Write the failing test**

Create tests that mock repository and Kratos interactions to verify:
- selector matches are unioned
- Kratos identities are expanded into linked Mongo user/account/wallet/merchant records
- missing linked records do not crash the lookup
- the lookup result preserves both seed matches and expanded connected records

**Step 2: Run test to verify it fails**

Run: `yarn test:unit test/flash/unit/app/admin/identity-cleanup/lookup.spec.ts`
Expected: FAIL because the lookup module does not exist yet.

**Step 3: Write minimal implementation**

Implement lookup helpers that:
- resolve selectors against Kratos and Mongo sources
- union discovered identity/user/account IDs
- fetch connected records through existing repositories or small admin-specific adapters
- return a structured lookup graph suitable for rendering and planning

Export the main lookup function from `src/app/admin/index.ts` if that improves reuse.

**Step 4: Run test to verify it passes**

Run: `yarn test:unit test/flash/unit/app/admin/identity-cleanup/lookup.spec.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add test/flash/unit/app/admin/identity-cleanup/lookup.spec.ts src/app/admin/identity-cleanup/lookup.ts src/app/admin/index.ts
git commit -m "feat: add cleanup cli lookup engine"
```

### Task 4: Implement plan generation and artifact writing

**Files:**
- Create: `src/app/admin/identity-cleanup/plan.ts`
- Test: `test/flash/unit/app/admin/identity-cleanup/plan.spec.ts`

**Step 1: Write the failing test**

Create tests that assert:
- plans freeze exact IDs from a lookup result
- plans include env, selectors, timestamps, and artifact paths
- plans exclude non-target collections like ledger history
- broad-match guardrails fail unless an override is set

**Step 2: Run test to verify it fails**

Run: `yarn test:unit test/flash/unit/app/admin/identity-cleanup/plan.spec.ts`
Expected: FAIL because the planning module does not exist yet.

**Step 3: Write minimal implementation**

Implement plan creation and JSON artifact serialization. Default artifact output should target `~/Documents/Island-Bitcoin/Flash/tmp/flash-admin-cleanup/...` with predictable subfolders for lookup, plan, backup, apply, and verify outputs.

**Step 4: Run test to verify it passes**

Run: `yarn test:unit test/flash/unit/app/admin/identity-cleanup/plan.spec.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add test/flash/unit/app/admin/identity-cleanup/plan.spec.ts src/app/admin/identity-cleanup/plan.ts
git commit -m "feat: add cleanup cli plan generation"
```

### Task 5: Implement apply engine with idempotent delete handling

**Files:**
- Create: `src/app/admin/identity-cleanup/apply.ts`
- Test: `test/flash/unit/app/admin/identity-cleanup/apply.spec.ts`

**Step 1: Write the failing test**

Create tests that assert:
- apply deletes Kratos sessions before identities
- Mongo wallets/accounts/users/merchants are deleted in a stable order
- Kratos delete-time 404s are recorded as already absent, not fatal
- apply supports both plan-file input and direct criteria input abstraction
- partial failures are surfaced in structured output

**Step 2: Run test to verify it fails**

Run: `yarn test:unit test/flash/unit/app/admin/identity-cleanup/apply.spec.ts`
Expected: FAIL because the apply module does not exist yet.

**Step 3: Write minimal implementation**

Implement the execution engine with explicit operation ordering, idempotent Kratos delete behavior, and structured result capture. Keep this logic reusable from both CLI and future automation wrappers.

**Step 4: Run test to verify it passes**

Run: `yarn test:unit test/flash/unit/app/admin/identity-cleanup/apply.spec.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add test/flash/unit/app/admin/identity-cleanup/apply.spec.ts src/app/admin/identity-cleanup/apply.ts
git commit -m "feat: add cleanup cli apply engine"
```

### Task 6: Implement post-apply verification

**Files:**
- Create: `src/app/admin/identity-cleanup/verify.ts`
- Test: `test/flash/unit/app/admin/identity-cleanup/verify.spec.ts`

**Step 1: Write the failing test**

Create tests that verify the verification stage:
- rechecks deleted identities and Mongo records by exact IDs
- distinguishes zero remaining matches from query failures
- returns a concise machine-readable verification summary

**Step 2: Run test to verify it fails**

Run: `yarn test:unit test/flash/unit/app/admin/identity-cleanup/verify.spec.ts`
Expected: FAIL because the verify module does not exist yet.

**Step 3: Write minimal implementation**

Implement exact-ID verification helpers for the plan’s target records and serialize their results into a verification artifact.

**Step 4: Run test to verify it passes**

Run: `yarn test:unit test/flash/unit/app/admin/identity-cleanup/verify.spec.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add test/flash/unit/app/admin/identity-cleanup/verify.spec.ts src/app/admin/identity-cleanup/verify.ts
git commit -m "feat: add cleanup cli verification"
```

### Task 7: Add human and JSON renderers

**Files:**
- Create: `src/app/admin/identity-cleanup/render.ts`
- Test: `test/flash/unit/app/admin/identity-cleanup/render.spec.ts`

**Step 1: Write the failing test**

Create tests that verify:
- human output is readable and grouped by accounts, users, wallets, merchants, and identities
- JSON output emits stable structured payloads
- alreadyAbsent and error cases are visible in apply output

**Step 2: Run test to verify it fails**

Run: `yarn test:unit test/flash/unit/app/admin/identity-cleanup/render.spec.ts`
Expected: FAIL because the renderer module does not exist yet.

**Step 3: Write minimal implementation**

Implement text and JSON renderers that consume lookup, plan, apply, and verify result structures without embedding business logic in the CLI layer.

**Step 4: Run test to verify it passes**

Run: `yarn test:unit test/flash/unit/app/admin/identity-cleanup/render.spec.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add test/flash/unit/app/admin/identity-cleanup/render.spec.ts src/app/admin/identity-cleanup/render.ts
git commit -m "feat: add cleanup cli renderers"
```

### Task 8: Build the CLI entrypoint and argument parsing

**Files:**
- Create: `dev/bin/flash-admin-cleanup.ts`
- Modify: `package.json`
- Test: `test/flash/unit/dev/bin/flash-admin-cleanup.spec.ts`

**Step 1: Write the failing test**

Create tests that verify:
- `lookup`, `plan`, and `apply` subcommands parse correctly
- `--env test|prod` is required
- selectors can be supplied multiple times and unioned
- `--plan` and `--direct` rules are enforced for apply
- `--json` toggles structured output

**Step 2: Run test to verify it fails**

Run: `yarn test:unit test/flash/unit/dev/bin/flash-admin-cleanup.spec.ts`
Expected: FAIL because the CLI entrypoint does not exist yet.

**Step 3: Write minimal implementation**

Use `yargs` to wire subcommands to the typed cleanup engine. Add a package script such as `flash-admin-cleanup` for local execution. Keep the entrypoint thin and push all real logic into the engine modules.

**Step 4: Run test to verify it passes**

Run: `yarn test:unit test/flash/unit/dev/bin/flash-admin-cleanup.spec.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add test/flash/unit/dev/bin/flash-admin-cleanup.spec.ts dev/bin/flash-admin-cleanup.ts package.json
git commit -m "feat: add flash admin cleanup cli entrypoint"
```

### Task 9: Add smoke coverage for artifact creation and safe flows

**Files:**
- Create: `test/flash/integration/app/admin/identity-cleanup.integration.spec.ts`
- Modify: any newly introduced test helpers if needed

**Step 1: Write the failing test**

Create an integration-oriented smoke test that verifies:
- a lookup result can produce a plan
- a plan can drive an apply execution through mocked repositories and Kratos adapters
- artifacts are written outside the repo to the configured temp root
- final verification runs even when some deletes are already absent

**Step 2: Run test to verify it fails**

Run: `yarn test:integration --runInBand test/flash/integration/app/admin/identity-cleanup.integration.spec.ts`
Expected: FAIL because the full flow is not wired yet.

**Step 3: Write minimal implementation**

Add only the missing wiring required for the smoke flow. Do not expand scope beyond v1 deletion behavior.

**Step 4: Run test to verify it passes**

Run: `yarn test:integration --runInBand test/flash/integration/app/admin/identity-cleanup.integration.spec.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add test/flash/integration/app/admin/identity-cleanup.integration.spec.ts
git commit -m "test: add cleanup cli smoke coverage"
```

### Task 10: Document operator usage

**Files:**
- Modify: `DEV.md`
- Modify: `docs/plans/2026-05-01-flash-admin-cleanup-design.md`
- Modify: `docs/plans/2026-05-01-flash-admin-cleanup.md`

**Status:** completed 2026-05-01

**Acceptance check:**
- operator docs cover `lookup`, `plan`, `apply`, `--json`, artifact locations, and prod safety expectations
- docs reflect the shipped CLI surface, especially repeatable `--selector type:value` inputs and the current meaning of `--plan` vs `--direct`

**Implementation notes:**
- added an operator-facing section to `DEV.md`
- updated the design doc so it matches the implemented CLI instead of the earlier dedicated-flag sketch
- kept the docs explicit that ledger/history collections remain out of scope

**Suggested commit:**

```bash
git add DEV.md docs/plans/2026-05-01-flash-admin-cleanup-design.md docs/plans/2026-05-01-flash-admin-cleanup.md
git commit -m "docs: add flash admin cleanup cli operator guide"
```

### Task 11: Final verification before implementation handoff

**Files:**
- Modify: none unless fixes are required

**Step 1: Run targeted unit tests**

Run:
```bash
yarn test:unit test/flash/unit/app/admin/identity-cleanup/types.spec.ts
yarn test:unit test/flash/unit/app/admin/identity-cleanup/normalize.spec.ts
yarn test:unit test/flash/unit/app/admin/identity-cleanup/lookup.spec.ts
yarn test:unit test/flash/unit/app/admin/identity-cleanup/plan.spec.ts
yarn test:unit test/flash/unit/app/admin/identity-cleanup/apply.spec.ts
yarn test:unit test/flash/unit/app/admin/identity-cleanup/verify.spec.ts
yarn test:unit test/flash/unit/app/admin/identity-cleanup/render.spec.ts
yarn test:unit test/flash/unit/dev/bin/flash-admin-cleanup.spec.ts
```
Expected: PASS.

**Step 2: Run integration smoke test**

Run:
```bash
yarn test:integration --runInBand test/flash/integration/app/admin/identity-cleanup.integration.spec.ts
```
Expected: PASS.

**Step 3: Run static checks for touched code**

Run:
```bash
yarn tsc-check
yarn eslint-check
```
Expected: PASS with no new errors from the cleanup CLI.

**Step 4: Commit final verification state**

```bash
git add -A
git commit -m "chore: verify flash admin cleanup cli"
```
