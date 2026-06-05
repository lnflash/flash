# Draft: Branch Split Plan

## Requirements

- **Goal**: Split the current `feat/email-registration` branch into two new branches.
- **Branch 1 (Feature)**: `feat/email-registration-only`
- **Branch 2 (Fixes)**: `fix/typescript-refactors`

## Open Questions

- What is the correct base branch for the new branches (e.g., `main`)?
- How can the original "email registration" feature commits be identified (e.g., commit hashes, author, date)?

## My Commits (To be moved to `fix/typescript-refactors`)
- `b5d199fb7`: fix(types): update core Account and Wallet mocks
- `1e53038e7`: fix(tests): adapt to upstream API and infrastructure changes
- `0072e03d9`: refactor(tests): replace BTC wallet functions with USD equivalents
- `9dbf635b9`: fix(types): use factory functions for branded types
- `9acf530c3`: fix(types): resolve all remaining TypeScript errors
