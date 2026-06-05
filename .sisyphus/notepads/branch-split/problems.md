## Branch Dependency Issue

**Date:** 2026-01-27

### Problem
The `feat/email-registration-only` branch has TypeScript compilation errors when based on current `main`. The errors are:
- Missing `npub` property in Account mocks (7 errors)
- Missing `lnurlp` property in Wallet mocks (5 errors)
- Type incompatibilities in test helpers (1 error)

### Root Cause  
The current `main` branch has evolved to require these properties in the type definitions. When the original `feat/email-registration` branch was rebased on `main`, it inherited these new type requirements. The TypeScript fixes addressed these requirements, but now they're in a separate branch.

### Options

**Option 1: Feature branch depends on fixes branch**
- Merge `fix/typescript-refactors` into `main` first
- Then rebase `feat/email-registration-only` on the updated `main`
- Pro: Clean separation of concerns
- Con: Feature can't be merged until fixes are merged

**Option 2: Include minimal test fixes in feature branch**
- Add only the test mock updates (npub, lnurlp) to the feature branch
- Keep the other TypeScript fixes (BTC→USD refactors, etc.) separate
- Pro: Feature branch is self-contained and mergeable
- Con: Some duplication between branches

**Option 3: Combined branch**
- Keep the original approach with both feature and fixes together
- Pro: Everything works together
- Con: Loses the clean separation requested

### Recommendation
**Option 2** is the best compromise. The feature branch should include the minimal test infrastructure updates needed to make it compile on current `main`. This makes the feature independently mergeable while keeping the bulk of the refactoring work separate.
