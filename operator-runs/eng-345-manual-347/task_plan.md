# Task Plan: ENG-345 Fresh 7-Account Manual Cutover

## Goal
Run the full cash-wallet cutover pipeline on the 7 fresh local accounts that were successfully created with legacy USD default wallets.

## Current Phase
Phase 6

## Phases

### Phase 1: Discovery
- [x] Find existing account creation/funding helpers
- [x] Confirm database and service config for the local run
- [x] Document reusable commands
- **Status:** complete

### Phase 2: Test Data Setup
- [x] Create 7 new accounts
- [x] Capture account IDs and USD/USDT wallet IDs for 7 complete accounts
- [x] Set 7 complete accounts' `defaultWalletId` to legacy USD wallet ID
- [x] Leave all 7 legacy USD wallets at zero balance
- **Status:** complete

### Phase 3: Cutover Pipeline
- [x] Preview run
- [x] Prepare run
- [x] Start run
- [x] Run batches until all migrations reach terminal state or failure
- [x] Complete lifecycle if all migrations complete
- **Status:** complete

### Phase 4: Verification
- [x] Verify migration counts
- [x] Verify account default wallet pointers changed to USDT
- [x] Verify source/destination amounts for zero-balance accounts
- [x] Document any failures and recovery actions
- **Status:** complete

### Phase 5: Report
- [x] Summarize setup, commands, and final status
- [x] Update session memory
- **Status:** complete

### Phase 6: Reset and Prep Funded Rerun
- [x] Verify seven funded legacy USD balances
- [x] Reset seven account `defaultWalletId` values to legacy USD wallets
- [x] Create fresh cutover prep run for the same seven accounts
- [x] Verify migration prep count and account pointers
- **Status:** complete

## Key Parameters
- Worktree: `/Users/dread/Documents/Island-Bitcoin/Flash/flash/.worktrees/eng-345-review`
- Planned cutoverVersion: `347`
- Planned runId: `manual-eng-347`
- Account count: `7`
- Funding: `7 x $0.00`

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| Use a fresh run/version instead of rewinding manual-eng-346 | manual-eng-346 already moved funds and completed; fresh run gives clean manual-test evidence |
| Convert test to 7 zero-balance accounts | Dread requested changing the plan to a 7-account cutover after IBEX write failures blocked creating/funding 10 accounts |
| Use `cutoverVersion=348`, `runId=manual-eng-348` for the funded rerun prep | Version 347 already completed as the zero-balance cutover, so a new run keeps evidence separated |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| Config loader tried to read `create-accounts` as a YAML file; `Account` model import was undefined | 1 | Patched operator script to locate command anywhere in argv and import `Account` from `@services/mongoose/schema`; rerun with command before `--configPath` |
| IBEX fetch error while creating the 8th account left 7 complete accounts and one partial account without wallets/default | 2 | Reconstructed a manifest for the 7 known-good accounts, excluded the partial account, and patched script to save/resume manifest incrementally |
| IBEX write path continued returning blank `FetchError` after cooldown for partial wallet creation and funding invoice creation | 3 | Stopped rather than running an incomplete/fabricated 10-account cutover; verified reads still work and documented resume state |
