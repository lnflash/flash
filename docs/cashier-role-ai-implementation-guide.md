# AI Agent Implementation Guide for Cashier Role

## 🤖 Read This First

This guide provides explicit instructions for AI agents implementing the cashier role feature. Follow these instructions exactly.

## Pre-Implementation Checklist

Before starting ANY implementation:

1. **Read all documentation files**:
   - [ ] `cashier-role-implementation.md`
   - [ ] `cashier-role-phase1.md`
   - [ ] `cashier-role-api-design.md`
   - [ ] `cashier-login-requirements.md`
   - [ ] `cashier-role-testing.md`

2. **Analyze the codebase**:
   - [ ] Run `grep -r "role" src/` to find existing role implementation
   - [ ] Run `grep -r "Account" src/domain/` to understand account structure
   - [ ] Read `src/services/mongoose/schema.ts` completely
   - [ ] Understand the authentication flow in `src/app/authentication/`

3. **Verify environment**:
   - [ ] Check current branch: `git branch --show-current`
   - [ ] Ensure clean working directory: `git status`
   - [ ] Create implementation branch: `git checkout -b cashier-role/milestone-X`

## Implementation Template for Each Milestone

### Step 1: Create Implementation Plan Comment

Before any code changes, create a plan comment in the main file you'll be working on:

```typescript
/**
 * CASHIER_ROLE: Implementation Plan for Milestone X
 * 
 * Files to be modified:
 * 1. [file1.ts] - [what will be changed]
 * 2. [file2.ts] - [what will be changed]
 * 
 * Security considerations:
 * - [consideration 1]
 * - [consideration 2]
 * 
 * Testing approach:
 * - [test 1]
 * - [test 2]
 * 
 * Rollback plan:
 * - [how to revert if needed]
 * 
 * @milestone X
 * @estimated-loc XXX
 * @security-impact low|medium|high
 */
```

### Step 2: Implement with Extreme Documentation

For EVERY function/type/constant you add:

```typescript
/**
 * CASHIER_ROLE: [Component Name]
 * 
 * Purpose: [Detailed explanation of what this does]
 * 
 * Security: [Any security implications]
 * - [Specific security consideration 1]
 * - [Specific security consideration 2]
 * 
 * Dependencies: 
 * - [What this depends on]
 * - [External services used]
 * 
 * Side Effects:
 * - [Any side effects]
 * - [State changes]
 * 
 * Error Handling:
 * - [Error case 1]: [How it's handled]
 * - [Error case 2]: [How it's handled]
 * 
 * @example
 * ```typescript
 * // Example usage
 * const result = functionName(param1, param2)
 * ```
 * 
 * @param param1 - [Detailed description]
 * @param param2 - [Detailed description]
 * @returns [Detailed description of return value]
 * 
 * @throws {ErrorType} - [When this error is thrown]
 * 
 * @since cashier-role-v1
 * @security-review pending
 * @milestone X
 */
export const functionName = (param1: Type1, param2: Type2): ReturnType => {
  // Implementation with inline comments explaining logic
}
```

### Step 3: Testing Template

For every test file:

```typescript
/**
 * CASHIER_ROLE: Test Suite for [Component]
 * 
 * Test Coverage:
 * - Happy path scenarios
 * - Error scenarios
 * - Edge cases
 * - Security scenarios
 * 
 * @milestone X
 */

describe("CASHIER_ROLE: [Component Name]", () => {
  // Setup and teardown with detailed comments
  
  describe("Security Tests", () => {
    it("should prevent unauthorized access", async () => {
      // Test implementation
    })
    
    it("should validate all inputs", async () => {
      // Test implementation
    })
  })
  
  describe("Functional Tests", () => {
    it("should [specific behavior]", async () => {
      // Test implementation
    })
  })
  
  describe("Error Handling Tests", () => {
    it("should handle [error case]", async () => {
      // Test implementation
    })
  })
})
```

## Milestone-Specific Instructions

### Milestone 1: Type Definitions and Interfaces

1. **Start with domain types**:
   ```bash
   mkdir -p src/domain/cashier
   touch src/domain/cashier/index.types.d.ts
   ```

2. **Define types incrementally**:
   - First commit: Basic enums
   - Second commit: Interfaces
   - Third commit: Type guards
   - Fourth commit: Documentation

3. **Example structure**:
   ```typescript
   // src/domain/cashier/index.types.d.ts
   
   /**
    * CASHIER_ROLE: Core Type Definitions
    * [Full header comment as per template]
    */
   
   // Step 1: Permission enum
   export const CashierPermission = {
     ViewTransactions: "VIEW_TRANSACTIONS",
     // ... add one at a time with comments
   } as const
   
   // Step 2: Type from const
   export type CashierPermission = typeof CashierPermission[keyof typeof CashierPermission]
   
   // Step 3: Interfaces with full documentation
   export interface CashierSession {
     // Each field needs a comment
   }
   ```

### Git Workflow for Each Change

1. **Before starting work**:
   ```bash
   git status  # Ensure clean
   git pull origin feature/cashier-role  # Get latest
   git checkout -b cashier-role/milestone-X-part-Y
   ```

2. **After each logical change** (every 20-30 lines):
   ```bash
   git add -p  # Review each change
   git diff --cached  # Verify changes
   git commit -m "CASHIER_ROLE: [Specific change description]"
   ```

3. **Before creating PR**:
   ```bash
   git log --oneline -10  # Review commits
   git diff origin/feature/cashier-role  # Total changes
   # Ensure < 300 lines changed
   ```

## Common Pitfalls to Avoid

1. **DON'T**: Make changes without reading existing code first
2. **DON'T**: Skip error handling "to save time"
3. **DON'T**: Assume anything about the system - verify everything
4. **DON'T**: Make "while I'm here" changes outside the milestone scope
5. **DON'T**: Use `any` type - always define proper types
6. **DON'T**: Skip tests because "it's obvious it works"

## Security-First Mindset

For EVERY line of code, ask:
1. Can this be exploited?
2. Is input validated?
3. Are permissions checked?
4. Is sensitive data protected?
5. Are errors handled safely?
6. Is this action logged?

## Progress Tracking

After each session, update the implementation status:

```markdown
## Milestone X Progress
- [x] Created type definitions file
- [x] Added CashierPermission enum
- [ ] Added CashierSession interface
- [ ] Added type guards
- [ ] Created unit tests
- [ ] Updated documentation

**Lines changed**: XX/300
**Security review**: pending
**Next step**: [specific next action]
```

## Questions to Ask Before PR

1. Have I followed the commenting template exactly?
2. Are all edge cases handled?
3. Is the code self-documenting?
4. Would a security auditor approve this?
5. Can this be rolled back safely?
6. Have I tested failure scenarios?

Remember: **Quality over speed**. A well-documented, secure 50-line PR is better than a rushed 300-line PR. 