# Cash Wallet Cutover Day Runbook

This runbook is the one-time execution script for moving Flash Cash Wallet users from legacy IBEX USD presentation to IBEX USDT-backed Cash Wallet operation.

Use `OPERATIONS.md` as the reference manual for steady-state Bridge operations, replay, reconciliation, webhook incidents, and general deploy checks. This document is intentionally focused on cutover-day decisions and sequencing.

## Scope

This runbook covers:

- T-7 days through T-0 readiness checks.
- T-1 hour go/no-go decision.
- T-0 cutover execution.
- Hard abort criteria.
- Verification after `IN_PROGRESS` and `COMPLETE`.
- T+1 hour and T+24 hour reconciliation.
- Handoff to rollback planning when abort criteria are met.

Out of scope:

- Bridge steady-state operations. See `OPERATIONS.md`.
- Server implementation. See ENG-345.
- Mobile implementation. See ENG-346.
- Legal/customer communications approval. See COM-44.
- Full rollback procedure. See ENG-364.

## Cutover Principles

- No silent ambiguity: every go/no-go decision needs a named owner and timestamp.
- Do not manually mutate user wallet state during cutover without a written repair plan and second reviewer.
- Keep old-client compatibility intact throughout the cutover. Clients without `X-Flash-Client-Capabilities: cash-wallet-usdt-v1` must continue to see legacy `USD`.
- Capable clients with `X-Flash-Client-Capabilities: cash-wallet-usdt-v1` must see `USDT`.
- Do not mark cutover `COMPLETE` until migration, wallet presentation, reconciliation, and support readiness all pass.
- If rollback is needed after irreversible wallet/default changes, treat it as a data repair project, not a normal deploy rollback.

## Roles

Fill this table before the staging rehearsal and again before production cutover.

| Role | Name | Backup | Required at T-1h? | Required at T-0? |
| --- | --- | --- | --- | --- |
| Cutover commander | Dread | TBD | Yes | Yes |
| Ops executor | Olaniran | TBD | Yes | Yes |
| Backend owner | TBD | TBD | Yes | Yes |
| Mobile owner | Nick | TBD | Yes | On call |
| Support lead | TBD | TBD | Yes | On call |
| Comms/legal approver | TBD | TBD | Yes | No |
| Incident commander fallback | TBD | TBD | Yes | Yes |

## Required Artifacts

Create or link these before T-1 day:

- Production release commit SHA.
- Bridge operations `OPERATIONS.md` branch/commit.
- Staging rehearsal notes.
- Backend deployment evidence.
- Mobile rollout status for ENG-346.
- COM-44 approved comms.
- Dashboard links.
- PagerDuty/Slack on-call schedule.
- Bridge dashboard/config screenshots or internal references.
- Cutover run ID.
- Config snapshot reference.
- Rollback/repair owner for ENG-364.

Do not paste secrets, bearer tokens, Bridge API keys, webhook public keys copied from private channels, replay secrets, or Bruno local environment files into this runbook.

## Dependencies

Do not proceed to production cutover unless all required dependencies are deployed or explicitly waived by the cutover commander.

| Dependency | Required state | Owner | Status |
| --- | --- | --- | --- |
| ENG-345 server cutover support | Deployed and smoke-tested | Backend | TBD |
| ENG-346 mobile cutover UX | Shipped or rollout plan approved | Mobile | TBD |
| ENG-296 / ENG-297 USDT wallet support | Deployed and verified | Backend | TBD |
| COM-44 comms/legal | Approved | Comms/legal | TBD |
| Bridge webhook server | Healthy in target env | Ops | TBD |
| Bridge reconciliation | Runs cleanly or known exceptions documented | Ops/backend | TBD |
| Monitoring dashboards | Live | Ops | TBD |
| PagerDuty/Slack on-call | Active | Ops | TBD |
| ENG-364 rollback plan | Draft reviewed or waived | Ops/backend | TBD |

## T-7 Days Checklist

- Confirm production cutover date and window.
- Confirm the cutover commander, ops executor, backend owner, mobile owner, support lead, and comms/legal approver.
- Confirm ENG-345 is merged and deployed to staging.
- Confirm ENG-346 status and mobile rollout plan.
- Confirm COM-44 comms are drafted and routed for approval.
- Confirm Bridge dashboard access for the ops executor and backup.
- Confirm production config owner and secret owner.
- Confirm rollback owner and decision window.
- Confirm customer support has an escalation channel and internal FAQ draft.
- Schedule staging rehearsal.

Exit criteria:

- All named roles have accepted ownership.
- Dependencies have owners and target dates.
- Staging rehearsal is scheduled.

## T-3 Days Checklist

- Deploy the release candidate to staging.
- Run Bridge GraphQL smoke checks.
- Run Bridge webhook `/health`.
- Run replay dry-run for a narrow recent window.
- Run Bridge reconciliation with a 24-hour window.
- Verify no unresolved high-severity `bridge_without_ibex` orphan.
- Verify old-client no-header wallet query returns legacy `USD`.
- Verify capable-client wallet query returns `USDT`.
- Verify admin `cashWalletCutover` query works.
- Confirm dashboards show webhook status, reconciliation orphan counts, Bridge API errors, and cutover state changes.
- Confirm support can identify and escalate cutover issues.

Exit criteria:

- Staging passes the smoke matrix.
- Any known issue has an owner and explicit production go/no-go impact.

## T-1 Day Checklist

- Freeze unrelated Bridge/Cash Wallet deploys unless approved by the cutover commander.
- Confirm production release SHA.
- Confirm production config snapshot.
- Confirm production Bridge webhook public keys and replay secret are present.
- Confirm mobile rollout state.
- Confirm customer/support comms are approved.
- Confirm PagerDuty/Slack rotation.
- Confirm the rollback/repair decision tree is available.
- Confirm a staging rehearsal has completed, or record the explicit waiver.
- Create the production cutover run ID.

Exit criteria:

- Cutover commander signs off.
- Ops executor signs off.
- Backend owner signs off.
- Support lead signs off.
- Comms/legal approver signs off if user-facing comms are planned.

## T-1 Hour Go/No-Go

Record the decision in the issue, deployment channel, or operator log before touching production state.

| Gate | Go condition | Abort condition | Owner | Result |
| --- | --- | --- | --- | --- |
| Release SHA | Expected SHA deployed | Wrong or unknown SHA | Backend | TBD |
| Migrations | Applied with no failure | Pending or failed migration | Backend | TBD |
| Webhook health | `/health` returns OK | Unhealthy webhook server | Ops | TBD |
| Bridge API | Normal latency/error rate | Bridge outage or auth failures | Ops | TBD |
| Reconciliation | No high-severity unresolved orphan | New critical orphan growth | Backend/Ops | TBD |
| Old-client compatibility | No-header query returns `USD` | No-header query returns `USDT` or errors | Backend | TBD |
| Capable-client behavior | Capability query returns `USDT` | Capability query returns `USD` or errors | Backend/Mobile | TBD |
| Mobile readiness | ENG-346 status accepted | Unknown or unacceptable rollout risk | Mobile | TBD |
| Support readiness | Support lead online | Support not staffed | Support | TBD |
| On-call | PagerDuty/Slack rotation active | No accountable responder | Ops | TBD |
| Comms | Approved or waived | Required comms not approved | Comms/legal | TBD |

Decision:

- `GO`: proceed to T-0 execution.
- `NO-GO`: keep state at `PRE`, announce abort, record blocker and owner.
- `GO WITH WAIVER`: only allowed if the cutover commander records the waived gate, reason, risk owner, and rollback implication.

Hard abort criteria:

- Production webhook server is unhealthy.
- Bridge API auth fails.
- Old-client no-header query does not return legacy `USD`.
- Capable-client query does not return `USDT`.
- Reconciliation shows unresolved high-severity deposit mismatch.
- Required decision owner is unavailable.
- Support cannot staff the cutover window.
- Unknown production commit or config.

## T-0 Execution

Use one shared operator log. Record timestamps, operator, command/tool used, and result for each step.

Set these variables once and record them in the operator log:

```bash
export CUTOVER_VERSION=345
export CUTOVER_RUN_ID="<production-run-id>"
export OPERATOR="<operator-email>"
export PROD_CONFIG_PATH="<production-config-path>"
```

Before running any command, confirm `git rev-parse HEAD`, `PROD_CONFIG_PATH`, and the config snapshot's Bridge environment/base URL match the target production environment.

### 1. Confirm Starting State

Query current admin cutover state:

```graphql
query CashWalletCutoverState {
  cashWalletCutover {
    state
    scheduledAt
    startedAt
    completedAt
    pausedAt
    pauseReason
    cutoverVersion
    runId
    updatedBy
    updatedAt
  }
}
```

Expected:

- `state` is `PRE`.
- `runId` is either absent or matches the planned production run.
- No unexpected `pausedAt` or `pauseReason`.

If unexpected, stop and resolve before proceeding.

### 2. Run Final Pre-Migration Smoke Checks

Run both wallet presentation checks against a known migrated test account or controlled production canary.

No capability header expected result:

- Cash wallet presents as `USD`.
- Legacy balance is USD-compatible.

Capability header expected result:

- Cash wallet presents as `USDT`.
- Balance uses USDT smallest-unit semantics.

Example header:

```text
X-Flash-Client-Capabilities: cash-wallet-usdt-v1
```

Do not proceed if either presentation check fails.

### 3. Set Cutover `IN_PROGRESS`

Preview and prepare the production cohort before setting `IN_PROGRESS`:

```bash
node lib/scripts/cash-wallet-cutover.js preview \
  --configPath "$PROD_CONFIG_PATH" \
  --cutover-version "$CUTOVER_VERSION" \
  --run-id "$CUTOVER_RUN_ID" \
  --operator "$OPERATOR"

node lib/scripts/cash-wallet-cutover.js prepare \
  --configPath "$PROD_CONFIG_PATH" \
  --cutover-version "$CUTOVER_VERSION" \
  --run-id "$CUTOVER_RUN_ID" \
  --operator "$OPERATOR"
```

Use the admin `cashWalletCutoverUpdate` mutation, Bruno operator file `03-set-in-progress.bru`, or the operator CLI:

```bash
node lib/scripts/cash-wallet-cutover.js start \
  --configPath "$PROD_CONFIG_PATH" \
  --cutover-version "$CUTOVER_VERSION" \
  --run-id "$CUTOVER_RUN_ID" \
  --operator "$OPERATOR"
```

Record:

- Operator.
- Timestamp.
- Run ID.
- Cutover version.
- Commit SHA.
- State response.

Expected:

- Public and admin `cashWalletCutover.state` return `IN_PROGRESS`.
- No spike in GraphQL errors.
- Old-client/capable-client presentation still passes.

### 4. Run Migration

Run one batch at a time and inspect status after each batch:

```bash
node lib/scripts/cash-wallet-cutover.js run-batch \
  --configPath "$PROD_CONFIG_PATH" \
  --cutover-version "$CUTOVER_VERSION" \
  --run-id "$CUTOVER_RUN_ID" \
  --operator "$OPERATOR" \
  --worker-id "$OPERATOR-manual-1" \
  --limit 25

node lib/scripts/cash-wallet-cutover.js status \
  --configPath "$PROD_CONFIG_PATH" \
  --cutover-version "$CUTOVER_VERSION" \
  --run-id "$CUTOVER_RUN_ID" \
  --operator "$OPERATOR"
```

Repeat `run-batch` until `status` shows no remaining runnable migration records. Preserve each JSON output in the operator log. If a batch exits non-zero or reports `failed` or `requires_operator_review`, stop and invoke the abort/rollback handoff below.

Record:

- Command/tool name and exact args.
- Start timestamp.
- End timestamp.
- Cohort size.
- Success count.
- Failure count.
- Checkpoint reference.
- Log reference.

Monitor:

- Migration failures.
- GraphQL error rate.
- Bridge webhook failures.
- IBEX deposit/ledger anomalies.
- Cash wallet presentation errors.
- Support escalations.

If the job fails before irreversible changes, pause and decide whether to resume or abort. If failures occur after irreversible changes, stop manual action and invoke the ENG-364 repair/rollback decision process.

### 5. Verify During `IN_PROGRESS`

Before completing:

- Admin cutover state is `IN_PROGRESS`.
- Migration job reports complete or expected partial state.
- No unresolved migration failures.
- No-header wallet query returns `USD`.
- Capability wallet query returns `USDT`.
- Bridge reconciliation runs successfully.
- No new unresolved high-severity orphan.
- Support has no blocker-level customer escalation.

Do not set `COMPLETE` if any check fails.

### 6. Set Cutover `COMPLETE`

Set the cutover state to `COMPLETE` only after the `IN_PROGRESS` verification passes.

Use the admin `cashWalletCutoverUpdate` mutation, Bruno operator file `04-set-complete.bru`, or the operator CLI:

```bash
node lib/scripts/cash-wallet-cutover.js complete \
  --configPath "$PROD_CONFIG_PATH" \
  --cutover-version "$CUTOVER_VERSION" \
  --run-id "$CUTOVER_RUN_ID" \
  --operator "$OPERATOR"
```

Record:

- Operator.
- Timestamp.
- State response.
- Commit SHA.
- Run ID.

Expected:

- Admin and public `cashWalletCutover.state` return `COMPLETE`.
- Old clients continue to see legacy `USD`.
- Capable clients see `USDT`.

### 7. Post-Complete Smoke Checks

Run immediately after `COMPLETE`:

- No-header wallet query.
- Capability-header wallet query.
- Cash wallet transaction-history query.
- Known account transaction detail query.
- Bridge reconciliation with at least the cutover window.
- Webhook health check.
- Bridge GraphQL smoke query.

Expected:

- No-header clients: legacy `USD` compatibility.
- Capable clients: `USDT`.
- No new critical reconciliation orphan.
- No webhook signature or auth failures.
- No unexpected support escalation.

## T+1 Hour Checks

- Re-run Bridge reconciliation.
- Review dashboard error rates.
- Review webhook request status by route.
- Review Bridge API latency and non-2xx rate.
- Review support tickets.
- Spot-check at least three migrated accounts.
- Confirm old-client compatibility still holds.
- Confirm capable-client USDT presentation still holds.
- Record known issues and owners.

If any high-severity issue appears, open an incident and decide whether to invoke ENG-364.

## T+24 Hour Checks

- Run reconciliation with a 24-hour window.
- Review all reconciliation orphans.
- Confirm no orphan needs manual repair.
- Spot-check migrated account balances and recent transaction history.
- Review failed/pending Bridge transfers.
- Review webhook replay logs.
- Review support volume and themes.
- Decide whether to continue, pause, or accelerate legacy sunset planning.
- Schedule postmortem if there was any incident, waiver, failed gate, or customer-impacting issue.

## Abort and Rollback Handoff

Abort before `IN_PROGRESS`:

- Keep cutover state at `PRE`.
- Announce no-go.
- Record blocker, owner, and next review time.

Abort during `IN_PROGRESS`:

- Pause or stop the migration worker according to the implementation.
- Preserve logs, checkpoints, and run ID.
- Do not manually mutate wallets.
- Decide whether to resume, complete, or invoke ENG-364.

Abort after `COMPLETE`:

- Treat as production incident and data repair.
- Keep client-aware presentation intact unless it is the root cause.
- Invoke ENG-364 rollback/repair process.
- Require written repair plan and second reviewer before changing wallet/default state.

Rollback handoff packet:

- Run ID.
- Cutover version.
- Production commit SHA.
- Config snapshot.
- Migration checkpoint.
- Failed gate or incident trigger.
- Affected account count.
- Known affected account IDs, if any.
- Reconciliation output.
- Support impact summary.
- Proposed next action.

## Staging Rehearsal Log

Complete before production or record a signed waiver.

| Date | Environment | Commit SHA | Operator | Result | Notes |
| --- | --- | --- | --- | --- | --- |
| TBD | Staging | TBD | TBD | TBD | TBD |

Minimum rehearsal evidence:

- `PRE` state verified.
- `IN_PROGRESS` state set.
- Migration/cutover flow exercised.
- Preview and prepare outputs preserved.
- At least one partial batch run exercised.
- Resume after a stopped or stale worker lock exercised.
- Failed batch handling exercised, including `failed` or `requires_operator_review` operator decision.
- Abort before irreversible changes exercised.
- Abort after partial irreversible changes tabletop completed.
- `COMPLETE` state set.
- No-header wallet check passed.
- Capability-header wallet check passed.
- Old-client compatibility checked during partial migration.
- Reconciliation ran.
- Reconciliation orphan triage path exercised.
- Abort/rollback tabletop completed.

## Production Signoff

| Checkpoint | Name | Timestamp | Result | Notes |
| --- | --- | --- | --- | --- |
| T-1d readiness | TBD | TBD | TBD | TBD |
| T-1h go/no-go | TBD | TBD | TBD | TBD |
| `IN_PROGRESS` set | TBD | TBD | TBD | TBD |
| Migration complete | TBD | TBD | TBD | TBD |
| `COMPLETE` set | TBD | TBD | TBD | TBD |
| T+1h check | TBD | TBD | TBD | TBD |
| T+24h check | TBD | TBD | TBD | TBD |

## Links

- OPS-50: Cash Wallet Cutover Day go/no-go runbook.
- ENG-345: Server-side Cash Wallet cutover orchestration.
- ENG-346: Mobile Cash Wallet cutover screens and USDT card state.
- ENG-364: Cash Wallet cutover rollback contingency plan.
- COM-44: Customer/legal communications.
- `OPERATIONS.md`: Bridge steady-state operations reference.
