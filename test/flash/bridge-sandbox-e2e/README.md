# Bridge Sandbox E2E Tests

This suite exercises Bridge sandbox flows through the public GraphQL schema and local webhook handlers. It is opt-in by design: normal unit and integration test runs do not execute these specs.

## What It Covers

- Bridge KYC initiation
- Bridge virtual account creation
- External account link URL generation
- External-account webhook handling
- Deposit webhook handling and idempotency
- Withdrawal validation error paths
- Optional cash wallet cutover smoke checks
- Optional ETH-USDT Lightning parity smoke checks

The suite uses local MongoDB for test user setup, real Bridge/IBEX sandbox configuration for Bridge mutations, and direct Express handler injection for webhook tests. Webhook injection avoids requiring a public tunnel while still exercising the production route handlers.

## Prerequisites

Run from the repository root:

```bash
cd /path/to/your/repo
```

### `.env` Setup (First Run)

The package scripts source `.env` from the project root. Create or update `.env` with at minimum:

```bash
# Required
export IBEX_ENVIRONMENT=sandbox
export MONGODB_CON=mongodb://localhost:27017/flash

# Bridge sandbox — fill from Bridge dashboard
# These are the API key and webhook secret, not stored in .env directly in production:
export BRIDGE_BASE_URL=https://api.sandbox.bridge.xyz
export BRIDGE_WEBHOOK_URL=http://localhost:4009
```

### Required Setup

- Node dependencies installed or available in the worktree (`yarn install`).
- `.env` present and sourceable by the package script.
- MongoDB available using the repo's normal test configuration.
- `IBEX_ENVIRONMENT=sandbox` in `.env`.
- Bridge sandbox webhook secrets populated in `dev/config/base-config.yaml`:

  ```yaml
  bridge:
    webhook:
      secrets:
        kyc: "<sandbox-webhook-secret>"
        deposit: "<sandbox-webhook-secret>"
        transfer: "<sandbox-webhook-secret>"
        external_account: "<sandbox-webhook-secret>"
  ```

- `src/services/bridge/index.ts` service guard allowing Level 1 accounts (✅ already applied in this PR).

The setup file enforces the two safety gates:

- `RUN_BRIDGE_SANDBOX_E2E=true`
- `IBEX_ENVIRONMENT=sandbox`

The package scripts set `RUN_BRIDGE_SANDBOX_E2E=true` automatically, but `IBEX_ENVIRONMENT` must already be present in `.env` or exported in the shell.

## First Run (Human Verification)

Run from the worktree root:

```bash
cd /path/to/your/repo
source .env
IBEX_ENVIRONMENT=sandbox yarn test:bridge-sandbox-e2e
```

### What to check on first run

| Layer | What to verify | If it fails |
|-------|---------------|------------|
| Preflight | Source-code check of `checkAccountLevel()` allows level ≥ 1 | `src/services/bridge/index.ts` guard must be `level < 1`, not `level < 2` |
| KYC spec | `bridgeInitiateKyc` returns `{kycLink, tosLink}` URLs | Ensure ENG-345 deployed, sandbox has Bridge customer API set up |
| Virtual account | `bridgeCreateVirtualAccount` returns account details | Ensure ENG-297 deployed |
| External account | `bridgeAddExternalAccount` returns `{linkUrl, expiresAt}` | Check sandbox Plaid configuration |
| Deposit webhook | Injected webhook processes and persists deposit | Verify webhook secret in config.yaml |
| Withdrawal error paths | Validation errors returned for invalid inputs | Check withdrawal schema deployed (ENG-348) |
| Withdrawal **success** path | ⚠️ **Not expected to pass first run** — requires real KYC-approved sandbox customer, funded wallet, and verified external account. | The full withdrawal flow only runs with `BRIDGE_SANDBOX_WITHDRAWAL_CONFIRMED=true`; error-path tests run without it |

### If something fails

1. Check `IBEX_ENVIRONMENT` is `sandbox` (not `production`)
2. Confirm MongoDB is running: `mongosh --eval "db.adminCommand('ping')"`
3. Verify sandbox webhook secrets in `dev/config/base-config.yaml` match Bridge dashboard
4. Preflight failure → `src/services/bridge/index.ts` still has `level < 2` — apply the Task 0 fix
5. KYC/VA failures → confirm the corresponding ENG issue is deployed to sandbox

## Commands

Run the whole suite:

```bash
export IBEX_ENVIRONMENT=sandbox
yarn test:bridge-sandbox-e2e
```

Run the CI-style variant without `pino-pretty`:

```bash
export IBEX_ENVIRONMENT=sandbox
yarn test:bridge-sandbox-e2e:ci
```

Run one spec:

```bash
export IBEX_ENVIRONMENT=sandbox
TEST=test/flash/bridge-sandbox-e2e/deposit-withdrawal.spec.ts yarn test:bridge-sandbox-e2e:ci
```

Increase timeout for slow sandbox calls:

```bash
export IBEX_ENVIRONMENT=sandbox
JEST_TIMEOUT=240000 yarn test:bridge-sandbox-e2e:ci
```

## Optional Smoke Gates

These specs are skipped unless explicitly enabled:

```bash
export IBEX_ENVIRONMENT=sandbox
CUTOVER_TESTS=true yarn test:bridge-sandbox-e2e:ci
```

```bash
export IBEX_ENVIRONMENT=sandbox
LN_PARITY_TESTS=true yarn test:bridge-sandbox-e2e:ci
```

## Files

- `jest.config.js` - Jest config scoped to this suite.
- `jest.setup.ts` - opt-in guards, yargs config-path mock, MongoDB setup, Redis/Mongo cleanup.
- `preflight.ts` - source check that verifies Bridge Level 1 access is not blocked by the service guard.
- `helpers.ts` - test user creation, GraphQL execution, Bridge mutation wrappers, webhook injection, ERPNext lookup, deposit lookup.
- `helpers/http-utils.ts` - mock Express request/response objects for route-handler injection.
- `kyc-virtual-account.spec.ts` - KYC link and virtual account flow.
- `external-account.spec.ts` - Plaid link URL and external-account webhook behavior.
- `deposit-withdrawal.spec.ts` - deposit webhook handling, deposit persistence, withdrawal validation paths.
- `cutover-state.spec.ts` - optional cash wallet cutover state smoke test.
- `ln-parity.spec.ts` - optional Lightning USD invoice smoke test.

## Known Limitations

- KYC webhook assertions currently use a synthetic customer ID. To assert persisted KYC state, extract the real `bridgeCustomerId` created during sandbox KYC initiation.
- The external account spec verifies the link URL and injected webhook behavior, but it does not automate Plaid's browser flow.
- The deposit tests validate webhook handling and persistence. Full wallet-balance reconciliation depends on sandbox deposit state and is not asserted yet.
- Withdrawal success is not covered yet because it requires a real KYC-approved sandbox customer, funded wallet, and verified external account.
- ERPNext audit verification is available through `verifyErpnextAuditRow()`, but the current specs do not assert a successful `BridgeTransferRequest` row until the withdrawal success path is runnable.

## Troubleshooting

If the suite exits before running tests, check the setup guards first:

```bash
echo "$IBEX_ENVIRONMENT"
```

It must print `sandbox`.

If MongoDB setup fails, start the repo's normal local services before rerunning. The suite creates local test users and wallets before calling Bridge flows.

If preflight fails, inspect the guard in `src/services/bridge/index.ts`. The suite expects `BridgeService.checkAccountLevel()` to block Level 0 only, so Level 1 accounts can run Bridge operations.
