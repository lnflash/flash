# Bridge Operations Runbook

This runbook covers production operation for the Bridge.xyz integration and the related cash wallet cutover work. It is written for deploys, incident response, replay, reconciliation, and cutover execution.

The code is the source of truth. Older Bridge docs may mention `/bridge/webhooks/*`; the current webhook server exposes `/kyc`, `/deposit`, `/transfer`, `/internal/replay`, and `/health`.

## Scope

Bridge enables Flash users to move between USD bank rails and USDT:

- On-ramp: Bridge virtual account receives USD, Bridge converts to USDT, IBEX credits Flash.
- Off-ramp: Flash initiates Bridge transfer from USDT to a linked external bank account.
- Webhooks: Bridge reports KYC, deposit, and transfer events to Flash.
- Reconciliation: Flash compares Bridge deposits with IBEX deposit records and records orphans.
- Cash wallet cutover: ENG-345 makes USD/USDT wallet presentation client-aware while migration runs.

## Services

- GraphQL API: user and admin Bridge operations.
- Bridge webhook server: standalone Express server for Bridge webhooks.
- MongoDB: Bridge account mappings, deposit logs, replay logs, reconciliation orphans, and cutover state.
- Bridge.xyz API: KYC, virtual accounts, events, external accounts, and transfers.
- IBEX: USDT receive addresses and deposit crediting.

Key code paths:

- `src/services/bridge/client.ts`
- `src/services/bridge/index.ts`
- `src/services/bridge/webhook-server/index.ts`
- `src/services/bridge/reconciliation.ts`
- `src/scripts/replay-bridge-events.ts`
- `src/scripts/reconcile-bridge-ibex-deposits.ts`
- `src/graphql/admin/root/query/bridge-reconciliation-orphans.ts`
- `src/migrations/20260423000000-bridge-virtual-account-unique-accountid.ts`

## Required Config

Bridge config lives under `bridge` in the runtime config.

Required fields:

- `bridge.enabled`
- `bridge.apiKey`
- `bridge.baseUrl`
- `bridge.webhook.port`
- `bridge.webhook.publicKeys.kyc`
- `bridge.webhook.publicKeys.deposit`
- `bridge.webhook.publicKeys.transfer`
- `bridge.webhook.timestampSkewMs`

Optional or defaulted fields:

- `bridge.minWithdrawalAmount`
- `bridge.timeoutMs` defaults to `10000`
- `bridge.webhook.replaySecret`, or `BRIDGE_WEBHOOK_REPLAY_SECRET`

Never commit production API keys, replay secrets, webhook public keys copied from private channels, bearer tokens, or Bruno local environment files.

## Pre-Deploy Checklist

1. Confirm the exact branch and commit being deployed.
2. Confirm Bridge config is present for the target environment.
3. Confirm webhook public keys match Bridge dashboard values for KYC, deposit, and transfer events.
4. Confirm the webhook replay secret is present for operators, not exposed to clients.
5. Confirm MongoDB migration status.
6. Confirm Bridge API base URL points at the intended environment.
7. Confirm mobile client rollout status for `cash-wallet-usdt-v1` capability.
8. Confirm rollback owner, deploy owner, and decision owner.

Useful checks:

```bash
git rev-parse HEAD
yarn build
git diff --check
```

Full `yarn test:unit` and `yarn tsc-check` may currently include unrelated repo debt. For Bridge deploy confidence, use focused Bridge and cutover suites plus build and lint checks.

## Deployment Order

Deploy in this order:

1. Run database migrations.
2. Deploy GraphQL/backend.
3. Deploy Bridge webhook server.
4. Verify webhook health.
5. Verify GraphQL Bridge surfaces.
6. Verify replay dry run.
7. Run reconciliation.
8. Only after the above is healthy, execute cash wallet cutover phases.

### 1. Run Migrations

Use the repo's normal Mongo migration process for the target environment. The Bridge virtual account uniqueness migration must be applied before relying on production Bridge account mappings:

```bash
./scripts/mongodb-migrate.sh
```

Confirm no migration failed before continuing.

### 2. Deploy GraphQL

Deploy the backend with Bridge config enabled for the environment.

Post-deploy smoke checks:

- authenticated `bridgeKycStatus`
- authenticated `bridgeVirtualAccount`
- authenticated `bridgeExternalAccounts`
- admin `bridgeReconciliationOrphans`
- shared `cashWalletCutover` after ENG-345 is deployed

Example shape:

```graphql
query BridgeSmoke {
  bridgeKycStatus {
    status
  }
  bridgeVirtualAccount {
    id
    status
  }
  bridgeExternalAccounts {
    id
    status
  }
}
```

### 3. Deploy Webhook Server

The package script for local/dev execution is:

```bash
yarn bridge-webhook
```

Production should run the same server entrypoint with the production config and process supervisor. The server starts from:

```text
src/servers/bridge-webhook-server.ts
```

Current routes:

- `GET /health`
- `POST /kyc`
- `POST /deposit`
- `POST /transfer`
- `POST /internal/replay`

Health check:

```bash
curl -fsS "$BRIDGE_WEBHOOK_URL/health"
```

Expected response:

```json
{"status":"ok","service":"bridge-webhook"}
```

### 4. Verify Webhook Signatures

Bridge webhooks must include:

- `X-Webhook-Signature`

The expected header format is:

```text
X-Webhook-Signature: t=<timestamp_ms>,v0=<base64_signature>
```

Flash verifies `<timestamp_ms>.<raw_body>` using RSA-SHA256 and the configured public key for the event family. Expected behavior:

- `200`: accepted or idempotent duplicate.
- `400`: malformed payload.
- `401`: invalid or missing signature/timestamp.
- `500`: retryable server failure.

If signature failures spike after deploy, treat it as a config or raw-body parsing incident until proven otherwise.

## Replay Missed Bridge Events

Replay is for missed or failed Bridge webhooks. Always dry-run first.

Build first:

```bash
yarn build
```

Production replay must use the target environment config. Do not use `dev/config/base-config.yaml` for production; that file is for local/non-production testing.

Before any replay, record these values in the operator log:

```bash
test -n "$PROD_CONFIG_PATH"
test -n "$BRIDGE_WEBHOOK_URL"
git rev-parse HEAD
printf 'configPath=%s\nwebhookUrl=%s\ndryRun=%s\n' \
  "$PROD_CONFIG_PATH" "$BRIDGE_WEBHOOK_URL" "true"
```

Also confirm the config snapshot's `bridge.baseUrl` and environment name match the target environment before continuing.

Dry run:

```bash
BRIDGE_WEBHOOK_REPLAY_SECRET="$BRIDGE_WEBHOOK_REPLAY_SECRET" \
BRIDGE_WEBHOOK_URL="$BRIDGE_WEBHOOK_URL" \
node lib/scripts/replay-bridge-events.js \
  --configPath "$PROD_CONFIG_PATH" \
  --start 2026-05-01T00:00:00Z \
  --end 2026-05-02T00:00:00Z \
  --event-type deposit \
  --dry-run \
  --operator "ops@example.com"
```

Live replay:

```bash
BRIDGE_WEBHOOK_REPLAY_SECRET="$BRIDGE_WEBHOOK_REPLAY_SECRET" \
BRIDGE_WEBHOOK_URL="$BRIDGE_WEBHOOK_URL" \
node lib/scripts/replay-bridge-events.js \
  --configPath "$PROD_CONFIG_PATH" \
  --start 2026-05-01T00:00:00Z \
  --end 2026-05-02T00:00:00Z \
  --event-type deposit \
  --operator "ops@example.com"
```

Useful filters:

- `--event-type kyc`
- `--event-type deposit`
- `--event-type transfer`
- `--transfer-id <bridge-transfer-id>`

Replay writes to the replay log and posts to `/internal/replay`. If `/internal/replay` returns `503`, the replay secret is not configured on the webhook server.

## Reconciliation

Run reconciliation after deploy, after replay, and during incidents involving deposits.

```bash
yarn build
node lib/scripts/reconcile-bridge-ibex-deposits.js \
  --configPath "$PROD_CONFIG_PATH" \
  --window-hours 24
```

Default `--window-hours` is `0.25` or 15 minutes. Use a larger window for deploy verification or after an outage.

Admin query:

```graphql
query BridgeOrphans {
  bridgeReconciliationOrphans(limit: 50, orphanType: null, status: null) {
    id
    orphanType
    status
    amount
    createdAt
    updatedAt
  }
}
```

Primary orphan classes:

- `bridge_without_ibex`: Bridge says a deposit completed, but IBEX credit is missing or delayed.
- `ibex_without_bridge`: IBEX has a deposit that Flash cannot match to a Bridge deposit.

Do not manually credit or reverse funds from an orphan without a written repair plan and a second reviewer.

## Cash Wallet Cutover

ENG-345 introduces client-aware wallet presentation during the cash wallet migration.

Compatibility rule:

- Old clients without `X-Flash-Client-Capabilities: cash-wallet-usdt-v1` continue to see legacy `USD`.
- Capable clients with `X-Flash-Client-Capabilities: cash-wallet-usdt-v1` see `USDT`.
- This must hold during `PRE`, `IN_PROGRESS`, and `COMPLETE`.

Operator Bruno files from ENG-345:

- `dev/bruno/Flash GraphQL API/admin/cash-wallet-cutover/01-query-admin-state.bru`
- `dev/bruno/Flash GraphQL API/admin/cash-wallet-cutover/02-set-scheduled-pre.bru`
- `dev/bruno/Flash GraphQL API/admin/cash-wallet-cutover/03-set-in-progress.bru`
- `dev/bruno/Flash GraphQL API/admin/cash-wallet-cutover/04-set-complete.bru`
- `dev/bruno/Flash GraphQL API/notoken/queries/cash-wallet-cutover.bru`

The no-token Bruno file is an operator smoke check. Client-facing docs and support snippets should use the minimal public query below unless wider operational field exposure has been explicitly approved.

Cutover states:

- `PRE`: migration not active, schedule metadata may be present.
- `IN_PROGRESS`: migration is running or being actively validated.
- `COMPLETE`: cutover completed and client-aware presentation remains active for compatibility.

Admin state query:

```graphql
query CashWalletCutoverAdminState {
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

Public/client state query:

```graphql
query CashWalletCutoverPublicState {
  cashWalletCutover {
    state
    scheduledAt
  }
}
```

The schema may expose additional operational fields for shared resolver reuse. Do not rely on, publish, or paste `runId`, `updatedBy`, `updatedAt`, `pauseReason`, or migration audit fields in client-facing artifacts without explicit approval.

### Cutover Preflight

Before moving to `IN_PROGRESS`:

1. Confirm Bridge GraphQL smoke tests pass.
2. Confirm webhook `/health` passes.
3. Run Bridge deposit reconciliation.
4. Confirm no unresolved high-severity `bridge_without_ibex` orphan.
5. Confirm old-client no-header wallet query returns legacy `USD`.
6. Confirm capable-client wallet query returns `USDT`.
7. Confirm support and mobile teams know the scheduled window.
8. Save the exact run ID, operator, commit SHA, and config snapshot location.

### Cutover Execution

Set the operator variables once and reuse them:

```bash
export CUTOVER_VERSION=345
export CUTOVER_RUN_ID="<production-run-id>"
export OPERATOR="<operator-email>"
export PROD_CONFIG_PATH="<production-config-path>"
```

1. Set `PRE` with schedule metadata using the admin `cashWalletCutoverUpdate` mutation or the Bruno operator file `02-set-scheduled-pre.bru`.
2. Re-run no-header and capable-client wallet smoke checks.
3. Preview and prepare migration records:

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

4. Set `IN_PROGRESS` with the admin `cashWalletCutoverUpdate` mutation, Bruno `03-set-in-progress.bru`, or the CLI:

```bash
node lib/scripts/cash-wallet-cutover.js start \
  --configPath "$PROD_CONFIG_PATH" \
  --cutover-version "$CUTOVER_VERSION" \
  --run-id "$CUTOVER_RUN_ID" \
  --operator "$OPERATOR"
```

5. Run migration batches and inspect status after each batch:

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

Repeat `run-batch` until `status` shows no remaining runnable migration records. Preserve every JSON output in the operator log.

6. Monitor batch/checkpoint logs and GraphQL error rate.
7. Re-run wallet smoke checks during migration.
8. Run reconciliation.
9. Set `COMPLETE` only after migration and presentation checks pass:

```bash
node lib/scripts/cash-wallet-cutover.js complete \
  --configPath "$PROD_CONFIG_PATH" \
  --cutover-version "$CUTOVER_VERSION" \
  --run-id "$CUTOVER_RUN_ID" \
  --operator "$OPERATOR"
```

10. Re-run old-client and capable-client wallet checks after `COMPLETE`.

For a controlled canary account, record the expected balances before execution. Example from the review canary:

- No capability header: legacy `USD` wallet, `balance: 1000`.
- `X-Flash-Client-Capabilities: cash-wallet-usdt-v1`: `USDT` wallet, `balance: 10000000`.

## Rollback and Pause

Rollback is safest before irreversible wallet updates or default-wallet flips.

If Bridge deploy fails before cutover:

1. Disable Bridge feature access if needed.
2. Keep webhook server online if it can safely accept retries.
3. Roll back GraphQL/backend to the previous release.
4. Re-run reconciliation after recovery.

If webhook server fails:

1. Keep GraphQL available if user flows are safe.
2. Restore webhook route health.
3. Replay missed events by time window.
4. Run reconciliation.

If cutover is in `PRE`:

1. Keep state at `PRE`.
2. Fix the blocker.
3. Do not start migration.

If cutover is `IN_PROGRESS`:

1. Pause or stop the worker according to the cutover implementation.
2. Preserve logs, checkpoints, and run ID.
3. Do not manually mutate wallet state.
4. Decide whether to resume, complete, or write a repair plan.

If cutover is `COMPLETE`:

1. Treat rollback as a data repair project, not a normal deploy rollback.
2. Keep client-aware presentation intact unless it is the root cause.
3. Require a written repair plan and second reviewer before changing wallet/default state.

## Incident Playbooks

### Bridge API Down

Symptoms:

- KYC, virtual account, external account, or transfer operations fail.
- Bridge client errors rise.

Actions:

1. Confirm Bridge status and API base URL.
2. Pause user-facing Bridge mutations if failure rate is high.
3. Keep read-only status endpoints available if they are safe.
4. Retry only idempotent operations.
5. Reconcile when Bridge recovers.

### Webhook Signature Failures

Symptoms:

- High `401` rate on `/kyc`, `/deposit`, or `/transfer`.

Actions:

1. Confirm public keys for the affected event family.
2. Confirm proxy preserves raw body.
3. Confirm the timestamp in `X-Webhook-Signature` is inside `timestampSkewMs`.
4. Do not bypass signature verification in production.
5. After fixing, replay the affected event window.

### Bridge Deposit Without IBEX Credit

Symptoms:

- Reconciliation creates `bridge_without_ibex`.

Actions:

1. Confirm Bridge deposit status and transfer hash if available.
2. Check IBEX deposit ingestion delay.
3. Re-run reconciliation with a larger window.
4. If still orphaned, prepare a written repair plan.
5. Do not manually credit without approval and audit trail.

### IBEX Deposit Without Bridge Match

Symptoms:

- Reconciliation creates `ibex_without_bridge`.

Actions:

1. Confirm whether the IBEX deposit belongs to Bridge.
2. Check for delayed Bridge event ingestion.
3. Replay Bridge events around the deposit timestamp.
4. Investigate unknown source deposits before assigning them to a user.

### Withdrawal Stuck or Failed

Symptoms:

- Bridge transfer remains pending or failed.

Actions:

1. Query Bridge transfer state.
2. Check `/transfer` webhook delivery.
3. Replay transfer events for the affected transfer ID.
4. Confirm user-visible status matches Bridge state.
5. Escalate to Bridge support for unclear terminal states.

### Old Clients See Wrong Wallet

Symptoms:

- Clients without capability header see `USDT` unexpectedly.

Actions:

1. Confirm request headers at GraphQL edge.
2. Query wallet list with no capability header.
3. Query with `cash-wallet-usdt-v1`.
4. Check cash wallet cutover state.
5. Roll back presentation code if compatibility is broken before data repair is needed.

### Capable Clients Do Not See USDT

Symptoms:

- Clients with `X-Flash-Client-Capabilities: cash-wallet-usdt-v1` still see legacy `USD`.

Actions:

1. Confirm the exact header reaches GraphQL.
2. Confirm cutover state.
3. Check account wallet inventory and migration records.
4. Re-run focused wallet presentation tests.
5. Do not mark cutover `COMPLETE` until fixed.

## Monitoring Signals

Track these at minimum:

- Bridge GraphQL mutation error rate.
- Bridge API latency and non-2xx rate.
- Webhook request counts by route and status.
- Webhook signature failures.
- Webhook handler exceptions.
- Replay success, failure, and skipped counts.
- Reconciliation orphan counts by type and status.
- Bridge transfer pending age.
- Cash wallet cutover state changes.
- Cash wallet cutover batch/checkpoint failures.
- Old-client wallet presentation requests.
- Capable-client wallet presentation requests.

Alert on:

- webhook `5xx` sustained above baseline.
- any sustained webhook `401` after deploy.
- reconciliation orphan growth.
- transfer pending age exceeding expected Bridge SLA.
- cutover worker failure during `IN_PROGRESS`.
- old-client compatibility smoke failure.

## Post-Deploy Verification

After deploy:

1. `GET /health` on webhook server returns OK.
2. Bridge GraphQL smoke queries return without GraphQL errors.
3. A no-header wallet query shows legacy `USD`.
4. A capable-client wallet query shows `USDT`.
5. Replay dry-run succeeds for a narrow recent window.
6. Reconciliation completes.
7. No new unresolved high-severity orphans appear.
8. Logs show no signature, config, or Bridge API auth errors.

## Documentation Follow-Ups

This runbook should be updated when:

- Production process manager names and service names are finalized.
- Exact deploy commands for the target environment are confirmed.
- Bridge dashboard webhook URLs are finalized.
- ENG-345 cutover worker command names are finalized.
- Observability dashboards and alert links exist.
