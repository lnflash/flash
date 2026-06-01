# Cash Wallet Cutover Dashboard Lazy Balances Implementation Plan

> Implementation note: keep this local dashboard read-only and preserve the existing IBEX balance throttle.

**Goal:** Make the local Cash Wallet Cutover Dashboard render readiness and account structure immediately while IBEX wallet balances hydrate lazily in the background.

**Architecture:** Split dashboard data into a fast structural snapshot and a throttled balance refresh path. The structural snapshot reads Mongo, migrations, and preflight state, but does not call IBEX. A local in-memory balance cache and single-worker queue refresh wallet balances with the existing throttle and expose cached values through a lazy `/api/balances` endpoint.

**Tech Stack:** TypeScript, Express, existing Flash repositories, Jest unit tests, vanilla browser JavaScript.

---

## Task 1: Structural Snapshot Mode

**Files:**
- Modify: `src/app/cash-wallet-cutover/operator-dashboard.ts`
- Test: `test/flash/unit/app/cash-wallet-cutover/operator-dashboard.spec.ts`

**Steps:**
1. Add a failing unit test proving `buildCashWalletCutoverOperatorSnapshot` can produce rows without calling `getBalanceForWallet` when balance mode is disabled.
2. Add a placeholder balance formatter that returns `display: "loading"`, zero minor units, and a `status` field for balance hydration.
3. Thread a `balanceMode` option through the snapshot builder with default live behavior preserved for existing callers.
4. Verify existing live-balance tests still pass.

## Task 2: Balance Cache And Queue

**Files:**
- Modify: `src/scripts/cash-wallet-cutover-dashboard.ts`

**Steps:**
1. Add a focused unit-testable helper only if it can stay small; otherwise keep the cache local to the script.
2. Add an in-memory `Map<WalletId, CachedBalance>` and FIFO queue with de-duping.
3. Keep the existing one-wallet-at-a-time throttle and retry behavior inside the queue worker.
4. Add cache statuses for the first pass: `loading`, `fresh`, and `error`.

## Task 3: Lazy Balance Endpoints

**Files:**
- Modify: `src/scripts/cash-wallet-cutover-dashboard.ts`

**Steps:**
1. Change `/api/snapshot` to build structural snapshots only.
2. Add `GET /api/balances?walletIds=...&refresh=0|1`, returning cached balance payloads immediately and enqueueing requested wallet IDs.
3. Add `GET /api/balance-status` for queue length, refreshed count, loading count, and last sweep timestamp.
4. Keep `?refresh=1` on `/api/snapshot` as structural refresh only, not a full IBEX balance sweep.

## Task 4: Browser Lazy Hydration

**Files:**
- Modify: `src/scripts/cash-wallet-cutover-dashboard.ts`

**Steps:**
1. Render the structural snapshot immediately.
2. Collect wallet IDs from the structural snapshot and hand them to `/api/balances` without blocking first render.
3. Poll `/api/balances` and update the row objects in memory as balances arrive.
4. Show status text such as `Balances 24/192 refreshed` instead of blocking `Loading...`.
5. Ensure filters continue to work while balances are loading.

## Task 5: Verification

**Commands:**
1. Run focused unit tests:
   `PATH=/Users/dread/.nvm/versions/node/v20.20.0/bin:$PATH TEST=test/flash/unit/app/cash-wallet-cutover/operator-dashboard.spec.ts yarn test:unit`
2. Restart local dashboard:
   `tmux kill-session -t cutover-dashboard` then start the existing dashboard command.
3. Verify:
   - `GET /` returns HTML.
   - `GET /api/snapshot?refresh=1` returns quickly and reports `watchlistAccounts: 60`.
   - `GET /api/balances` returns immediately with cached/loading payloads.
   - `GET /api/balance-status` shows queue progress.

## Constraints

- Do not increase IBEX request rate.
- Do not mutate accounts, wallets, migrations, or cutover config.
- Keep dashboard local-only on `127.0.0.1`.
- Avoid broad refactors and generated-file churn.
