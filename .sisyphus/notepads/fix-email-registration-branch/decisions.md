
## Decision: How to Handle Remaining 71 Errors

**Context**: After completing tasks 1-8, the full type check revealed 71 additional errors not in the original plan.

**Analysis**:
The errors fall into clear categories:
1. FractionalCentAmount type mismatches (~50 errors) - Direct consequence of Task 6
2. Missing function replacement (~4 errors) - Oversight in original plan
3. Flash test infrastructure (~5 errors) - Pre-existing issues
4. Miscellaneous (~12 errors) - Various type incompatibilities

**Decision**: Continue working to resolve all errors. The original plan was incomplete, but the work is salvageable.

**Approach**:
1. Fix the `addInvoiceForRecipientForBtcWallet` errors (quick win)
2. Address the FractionalCentAmount type errors systematically
3. Fix remaining miscellaneous errors
4. Re-run verification

This is the right path forward because:
- The branch has already been rebased and partially fixed
- The remaining errors are mechanical fixes, not architectural issues
- Abandoning now would waste the work already done
