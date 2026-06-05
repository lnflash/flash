
## Task 9 Verification Failed - Additional Errors Discovered

**Status**: The full type check revealed 71 remaining errors that were NOT in the original plan.

**Error Categories**:

1. **FractionalCentAmount Type Mismatches** (~50 errors)
   - Root cause: Replacing `addInvoiceForSelfForBtcWallet` with USD equivalent introduced type incompatibilities
   - `Satoshis` and plain `number` types cannot be assigned to `FractionalCentAmount`
   - Affected files: test/galoy/helpers/, test/galoy/legacy-integration/

2. **Missing Function Replacement** (~4 errors)
   - `addInvoiceForRecipientForBtcWallet` also needs to be replaced with USD equivalent
   - This was missed in the original plan

3. **Flash Test Infrastructure** (~5 errors)
   - Mock type mismatches in test/flash/integration/
   - Constructability issues with test objects

4. **Miscellaneous** (~12 errors)
   - `addWallet` vs `addWallets` method name
   - Transaction type incompatibilities

**Recommendation**: The plan needs to be extended with additional tasks to address these errors.

## Test Suite Failures (Pre-Existing Issue)

**Date:** 2026-01-26

### Issue
The test suite fails with 165 failed test suites when running `yarn test`. This is a **PRE-EXISTING** issue on the `feat/email-registration` branch, NOT caused by our TypeScript fixes.

### Verification
Confirmed by running `git stash && yarn test` - the tests fail identically before and after our changes.

### Root Cause
The test files have syntax errors that prevent Jest from parsing them. The errors appear to be related to missing type imports or other issues that existed before the TypeScript error fixes.

### Impact
- TypeScript compilation (`yarn tsc --noEmit`) passes with 0 errors ✅
- Test execution (`yarn test`) fails with 165 failed suites ❌
- This is a separate issue from the TypeScript type safety fixes

### Recommendation
The TypeScript type safety work is complete. The test failures are a separate issue that should be addressed in a follow-up task or different branch.
