# Flash Admin Cleanup CLI Design

**Date:** 2026-05-01
**Status:** Approved
**Repo:** `/Users/dread/Documents/Island-Bitcoin/Flash/flash`

## Goal

Replace the ad hoc bash cleanup helper with a repo-local TypeScript admin CLI that can be used repeatedly by humans and by OpenClaw, while preserving strong safety rails around destructive identity-layer cleanup.

## Non-Goals

- No MCP implementation in v1.
- No direct integration into GraphQL admin APIs in v1.
- No ledger or historical payment deletion.
- No broad fuzzy matching beyond explicit selectors.

## Command Surface

The CLI will expose three subcommands:

- `lookup`
- `plan`
- `apply`

### Selectors supported in v1

The shipped CLI accepts repeatable `--selector type:value` arguments.

Supported selector types:
- `username`
- `phone`
- `email`
- `kratosId`

Multiple selectors may be supplied together. Selector results are unioned into one candidate set before record expansion.

## Core Model

The cleanup flow is intentionally split into three stages:

1. **Lookup** gathers candidate identities and connected application records.
2. **Plan** freezes the exact IDs that would be affected into an artifact.
3. **Apply** executes deletes against exact IDs, preferably from a saved plan.

This separation prevents criteria drift between preview and execution and makes repeated destructive actions auditable.

## Data Expansion Rules

Starting from the unioned selector matches, the CLI expands and reports connected records including:

- Kratos identities
- Mongo users
- Mongo accounts
- Mongo wallets
- Mongo merchants

The initial deletion scope remains intentionally narrow:

- delete Kratos sessions
- delete Kratos identities
- delete Mongo users
- delete Mongo accounts
- delete Mongo wallets linked to targeted accounts
- delete Mongo merchants for matching usernames

The tool must not touch:

- ledger/history collections
- `medici_*`
- `lnpayments`
- invoice history

## Repo Layout

### Entrypoint

- `dev/bin/flash-admin-cleanup.ts`

### Core modules

- `src/app/admin/identity-cleanup/types.ts`
- `src/app/admin/identity-cleanup/normalize.ts`
- `src/app/admin/identity-cleanup/lookup.ts`
- `src/app/admin/identity-cleanup/plan.ts`
- `src/app/admin/identity-cleanup/apply.ts`
- `src/app/admin/identity-cleanup/verify.ts`
- `src/app/admin/identity-cleanup/render.ts`

The CLI entrypoint is thin. Business logic lives under `src/app/admin/identity-cleanup/` so the same engine can later be reused by other interfaces.

## Artifact Location

Artifacts will live outside the repo by default:

- `~/Documents/Island-Bitcoin/Flash/tmp/flash-admin-cleanup/...`

Artifacts include:

- lookup snapshots
- plan JSON files
- backup JSON files
- apply reports
- verification reports

This keeps the repo clean while preserving evidence for destructive operations.

## Safety Model

### Defaults

- `lookup` is non-destructive.
- `plan` is non-destructive and writes an exact-ID artifact.
- `apply` currently accepts selectors directly, then performs lookup → plan → apply → verify in one run.

### Apply modes

- `--plan` means persist the generated plan artifact before deletion (recommended).
- `--direct` means skip writing the plan artifact and proceed straight from generated plan data to apply.
- Saved plan-file input remains a reasonable future enhancement, but is not the shipped v1 surface.

### Guardrails

- Require explicit `--env test|prod`.
- Use loud prod confirmations.
- Fail when match sets exceed a safety threshold unless explicitly overridden.
- Treat delete-time 404s as idempotent already-gone cases, not hard failures.
- Always run final verification.
- Support `--json` output for automation.

## Output Philosophy

Every destructive run should answer:

- what criteria were supplied
- what records matched
- what exact IDs were frozen into the plan
- what was deleted
- what was already absent
- what verification found afterward

The current CLI supports both human-readable grouped output and `--json` structured output for automation.

## Extensibility

The design is intentionally selector-first and plan-driven so it can grow safely.

Planned future additions include:

- saved plan-file input for apply
- additional selectors or linked records
- OpenClaw wrapper commands that shell into this CLI
- optional future MCP wrapper if cross-client usage becomes worth the overhead

## Recommended Implementation Approach

Build a typed core first, then wrap it with the CLI. Reuse existing Flash repo patterns for TypeScript, repositories, and Kratos integration. Keep the first release focused on identity-layer cleanup only, with TDD around lookup, planning, idempotent delete behavior, and verification output.
