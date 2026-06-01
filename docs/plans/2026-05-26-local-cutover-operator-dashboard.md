# Local Cash Wallet Cutover Operator Dashboard Plan

## Goal

Build a local-only dashboard at `http://localhost:3450` that lets an operator monitor the 60 cutover test accounts and their cash wallets through each cutover state. The dashboard must use raw backend repositories and wallet balances, not the GraphQL presentation layer, because public wallet queries intentionally hide either USD or USDT depending on client capability and cutover state.

## Constraints

- Read-only: the dashboard must not mutate accounts, wallets, balances, migrations, or cutover config.
- Local-only: bind to localhost and serve a static browser UI plus a JSON snapshot endpoint.
- Source of truth:
  - account manifests from `/tmp/eng345usd-20260526115410-local-backend-accounts.json` and `/tmp/eng345usdonly-20260526195758-accounts.json`
  - raw Mongo repositories for accounts, wallets, and cash-wallet-cutover state
  - `Wallets.getBalanceForWallet` for live balances
- Expected population:
  - 60 accounts
  - 110 current wallets before `provision-usdt-wallets`
  - 120 target wallets after every USD-only account receives USDT
- No production API behavior should change.

## Design

1. Add a pure dashboard snapshot builder under `src/app/cash-wallet-cutover/operator-dashboard.ts`.
   - Load account IDs from manifest records.
   - Fetch each account by id and all raw wallets by account id.
   - Identify checking USD and checking USDT wallets directly from raw wallet records.
   - Fetch live balances for each cash wallet.
   - Fetch cutover config and per-account migration records when config has `runId`.
   - Derive summary totals and account-level anomaly badges.

2. Add focused unit tests under `test/flash/unit/app/cash-wallet-cutover/operator-dashboard.spec.ts`.
   - Verify wallet grouping and current/target wallet counts.
   - Verify missing-USDT detection for USD-only accounts.
   - Verify funded USD-only count from USD cent balances.
   - Verify migration status counts and anomaly flags.

3. Add a thin local HTTP script under `src/scripts/cash-wallet-cutover-dashboard.ts`.
   - Accept `--port`, `--configPath`, optional `--run-id`, optional `--cutover-version`, optional `--expected-accounts`, and repeated `--manifest` arguments.
   - Default port: `3450`.
   - Bind explicitly to `127.0.0.1`.
   - Default manifests:
     - `/tmp/eng345usd-20260526115410-local-backend-accounts.json`
     - `/tmp/eng345usdonly-20260526195758-accounts.json`
   - Routes:
     - `GET /` static dashboard HTML/CSS/JS
     - `GET /api/snapshot` live JSON snapshot
   - Poll snapshot every 10 seconds from the browser, with a manual refresh button.
   - Cache server-side snapshots for a short TTL so browser refreshes do not hammer IBEX.

4. UI content.
   - Compact operational layout.
   - Summary strip for cutover state, run id/version, accounts, wallets current/target, missing USDT, funded USD-only, USD total, USDT total, and anomalies.
   - Filters for anomalies, funded only, missing USDT, nonzero USD, nonzero USDT, and migration status.
   - Per-account table with phone, account id, default wallet, USD wallet/balance, USDT wallet/balance, migration status, and anomaly badges.
   - Color coding:
     - green expected
     - yellow pending/missing-but-expected
     - red broken or dangerous anomalies

5. Verification.
   - Run the new unit test first and confirm it fails before implementation.
   - Implement the snapshot builder and dashboard script.
   - Run the focused unit test.
   - Run TypeScript check for touched files through the repo build/test path where practical.
   - Start the dashboard on `localhost:3450` and verify:
     - `GET /` returns HTML
     - `GET /api/snapshot` returns JSON
     - dashboard process is listening on port `3450`

## Risks

- `Wallets.getBalanceForWallet` returns currency-specific amount shapes; the snapshot builder must normalize cautiously and preserve raw balance display for unknown shapes.
- Account manifest shape may differ between the 50-account and 10-account batches. The loader should accept common `accountId`, `account.id`, `id`, `phone`, and `username` fields and fail with clear errors if no account id can be found.
- Prepared migration records may exist before cutover config has `runId`. The dashboard must accept explicit `--run-id` and `--cutover-version` and use them for migration lookup when provided.
- The manifest loader must support the actual top-level `accounts` and `created` arrays, reject duplicate account IDs, and by default validate that 60 accounts were loaded.
- Balance reads can be expensive across 110-120 wallets. The local server must cache snapshots with a short TTL, capture per-wallet balance errors, and avoid making every browser poll trigger a full IBEX balance sweep.
- Running through `ts-node` may need `transpile-only` and `tsconfig-paths/register`, matching the earlier local script behavior.
- Large account lists should remain cheap: 60 accounts and 120 wallets is small, so simple sequential fetches are acceptable for operator clarity.

## Dual-Model Review Notes

- Reviewer 1 required explicit migration lookup arguments so PRE/prepared migration records remain visible. Plan updated.
- Reviewer 1 required explicit currency on balance reads. Implementation will always pass `wallet.currency`.
- Reviewer 1 required support for both manifest shapes and default count validation. Plan updated.
- Reviewer 1 required loopback-only binding. Plan updated.
- Reviewer 1 recommended keeping the dashboard out of GraphQL/production HTTP routes. The module will only be consumed by the local script and unit tests.
- Reviewer 2 required server-side snapshot caching and a slower poll interval to avoid roughly 55-60 IBEX calls/sec. Plan updated.
- Reviewer 2 required dependency injection for the snapshot builder. The builder will take manifests, repos, cutover repo, and `getBalanceForWallet`.
