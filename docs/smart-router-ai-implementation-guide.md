# AI Agent Implementation Guide for Smart Router

## 🤖 Read This First - Critical Instructions

This guide provides step-by-step instructions for AI agents implementing the Smart Router feature. Follow these instructions EXACTLY.

## Understanding Smart Router

### What is Smart Router?
Smart Router creates a unified "Cash" wallet that combines:
1. **IBEX Lightning Balance** - Existing custodial Lightning integration
2. **eCash (Cashu) Tokens** - Offline-capable bearer assets stored locally
3. **Future Custodians** - Extensible for Strike, etc.

### Core Concept
Users see ONE balance but funds are intelligently managed across multiple sources for optimal fees, privacy, and reliability.

## Pre-Implementation Checklist

### 1. Read Documentation (2-3 hours)
- [ ] Read `smart-router-overview.md` - Understand the feature
- [ ] Read `smart-router-architecture.md` - Understand technical design
- [ ] Read `smart-router-security.md` - Understand security requirements
- [ ] Read `smart-router-methodical-implementation.md` - Understand milestone plan
- [ ] Read this guide completely before starting

### 2. Study Existing Code (1-2 hours)
```bash
# Understand current payment system
grep -r "lightning" src/app/
grep -r "payment" src/domain/
grep -r "wallet" src/services/

# Understand IBEX integration
find src -name "*ibex*" -type f | xargs cat | less

# Understand current wallet structure
cat src/domain/wallets/index.types.d.ts
```

### 3. Understand Cashu Protocol
- Review https://cashu.space/ documentation
- Understand bearer tokens concept
- Learn about mints and proofs

## Implementation Rules

### 1. Type Safety First
```typescript
// ❌ NEVER use 'any'
const token: any = parseToken(input)

// ✅ ALWAYS define proper types
const token: CashuToken = parseToken(input)
```

### 2. Security By Default
```typescript
// ❌ NEVER store sensitive data in plain text
localStorage.setItem('tokens', JSON.stringify(tokens))

// ✅ ALWAYS encrypt sensitive data
const encrypted = await vault.encrypt(tokens)
await secureStorage.save('tokens', encrypted)
```

### 3. Error Handling
```typescript
// ❌ NEVER ignore errors
try {
  await mintClient.getInfo()
} catch (e) {
  // Silent fail
}

// ✅ ALWAYS handle errors explicitly
try {
  await mintClient.getInfo()
} catch (error) {
  logger.error('SMART_ROUTER: Mint communication failed', { error, mint: mintUrl })
  throw new MintUnavailableError(mintUrl, error)
}
```

## Milestone-Specific Instructions

### Milestone 1: Type Definitions (Your First PR)

#### Step 1: Create Branch
```bash
git checkout feature/smart-router
git pull origin feature/smart-router
git checkout -b smart-router/milestone-1-types
```

#### Step 2: Create Type File
```typescript
// src/domain/cash-wallet/index.types.d.ts

/**
 * SMART_ROUTER: Implementation Plan for Milestone 1
 * 
 * Files to create:
 * 1. src/domain/cash-wallet/index.types.d.ts - Core type definitions
 * 2. src/domain/cash-wallet/errors.ts - Error types
 * 
 * Security considerations:
 * - Token types must support encryption metadata
 * - Balance types must prevent numeric overflow
 * - All external data types need validation markers
 * 
 * Testing approach:
 * - Type compilation tests
 * - Type guard validation tests
 * 
 * @milestone 1
 * @estimated-loc 200
 * @security-impact low
 */

// Start with adapter types
/**
 * SMART_ROUTER: Adapter Type Enum
 * 
 * Purpose: Identifies the type of payment adapter for routing decisions
 * 
 * Security: Used for adapter validation and capability checking
 * 
 * @since smart-router-v1
 */
type AdapterType = 
  (typeof import("./index").AdapterType)[keyof typeof import("./index").AdapterType]

// Add more types incrementally...
```

#### Step 3: Create Implementation File
```typescript
// src/domain/cash-wallet/index.ts

/**
 * SMART_ROUTER: Cash Wallet Domain Constants
 * 
 * Purpose: Export constants and enums for cash wallet domain
 * 
 * @since smart-router-v1
 * @security-review pending
 * @milestone 1
 */

export const AdapterType = {
  IBEX: "IBEX",
  CASHU: "CASHU",
  FUTURE: "FUTURE"
} as const

// Add other constants...
```

#### Step 4: Commit Pattern
```bash
# After EVERY logical addition (20-30 lines)
git add -p
git diff --cached
git commit -m "SMART_ROUTER: Add AdapterType enum and documentation"

# Check total changes
git diff origin/feature/smart-router --stat
# Should be < 300 lines total
```

### Milestone 2: Base Infrastructure

#### Key Focus Areas:
1. **Abstract Classes**: Define structure without implementation
2. **Interfaces**: Create contracts for services
3. **Factory Pattern**: Enable extensible adapter creation

#### Example Base Adapter:
```typescript
/**
 * SMART_ROUTER: Base Payment Adapter
 * 
 * Purpose: Abstract base class for all payment adapters providing
 * common functionality and enforcing interface implementation
 * 
 * Security: 
 * - All adapters must implement authentication
 * - Balance queries must be rate-limited
 * - Payment operations require explicit authorization
 * 
 * Performance:
 * - Adapters should cache balance for 30 seconds
 * - Failed operations should implement exponential backoff
 * 
 * @abstract
 * @since smart-router-v1
 * @security-review pending
 * @milestone 2
 */
export abstract class BasePaymentAdapter implements PaymentAdapter {
  protected readonly logger: Logger
  protected lastSync?: Date
  protected balanceCache?: BalanceCache
  
  constructor(
    public readonly id: string,
    public readonly type: AdapterType,
    protected readonly config: AdapterConfig
  ) {
    this.logger = new Logger(`SmartRouter:${type}:${id}`)
    this.validateConfig(config)
  }
  
  // Abstract methods that MUST be implemented
  abstract getBalance(): Promise<Balance>
  abstract payInvoice(invoice: string): Promise<PaymentResult>
  
  // Concrete methods with security checks
  protected validateConfig(config: AdapterConfig): void {
    if (!config.id || !config.type) {
      throw new InvalidAdapterConfigError('Missing required fields')
    }
    // More validation...
  }
}
```

### Common Implementation Patterns

#### 1. Secure Storage Pattern
```typescript
/**
 * SMART_ROUTER: Secure Token Storage
 * 
 * Always use platform-specific secure storage:
 * - iOS: Keychain with Secure Enclave
 * - Android: Android Keystore
 * - Never use localStorage or AsyncStorage
 */
class SecureTokenStorage {
  async store(token: CashuToken): Promise<void> {
    // 1. Validate token
    this.validateToken(token)
    
    // 2. Encrypt with platform key
    const encrypted = await this.encrypt(token)
    
    // 3. Store with metadata
    await this.platformStore.save({
      id: token.id,
      data: encrypted,
      timestamp: Date.now(),
      version: STORAGE_VERSION
    })
    
    // 4. Audit log
    await this.auditLog('token_stored', { tokenId: token.id })
  }
}
```

#### 2. Error Handling Pattern
```typescript
/**
 * SMART_ROUTER: Comprehensive Error Handling
 * 
 * Every error must include:
 * - Specific error code
 * - User-friendly message
 * - Technical details for debugging
 * - Recovery suggestions
 */
try {
  const result = await riskyOperation()
} catch (error) {
  // 1. Log with context
  logger.error('SMART_ROUTER: Operation failed', {
    operation: 'riskyOperation',
    error: error.message,
    stack: error.stack,
    context: getCurrentContext()
  })
  
  // 2. Wrap in domain error
  throw new SmartRouterError(
    SmartRouterErrorCode.OPERATION_FAILED,
    'Unable to complete payment', // User message
    { 
      originalError: error,
      operation: 'riskyOperation',
      recoverable: true
    }
  )
}
```

#### 3. Transaction Pattern
```typescript
/**
 * SMART_ROUTER: Atomic Transaction Pattern
 * 
 * All multi-step operations must be atomic:
 * - Track state at each step
 * - Implement rollback for failures
 * - Log all state transitions
 */
class PaymentTransaction {
  private steps: TransactionStep[] = []
  
  async execute(): Promise<TransactionResult> {
    const rollbackStack: RollbackAction[] = []
    
    try {
      // Execute each step
      for (const step of this.steps) {
        const result = await step.execute()
        rollbackStack.push(step.getRollbackAction())
        
        // Log state transition
        await this.logStateTransition(step, result)
      }
      
      return { success: true }
    } catch (error) {
      // Rollback in reverse order
      for (const rollback of rollbackStack.reverse()) {
        try {
          await rollback()
        } catch (rollbackError) {
          // Log but don't throw
          logger.error('Rollback failed', { rollbackError })
        }
      }
      throw error
    }
  }
}
```

## Testing Requirements

### For EVERY Component:

1. **Unit Tests** (in same PR)
```typescript
describe('SMART_ROUTER: ComponentName', () => {
  describe('Security', () => {
    it('should validate all inputs')
    it('should handle malicious data')
    it('should enforce rate limits')
  })
  
  describe('Functionality', () => {
    it('should perform expected operation')
    it('should handle edge cases')
  })
  
  describe('Error Handling', () => {
    it('should throw specific errors')
    it('should provide recovery info')
  })
})
```

2. **Integration Tests** (separate PR)
```typescript
describe('SMART_ROUTER: Integration', () => {
  it('should work with real services')
  it('should handle network failures')
  it('should recover from errors')
})
```

## Progress Tracking

After each coding session, update the progress file:

```markdown
# Milestone X Progress

## Completed
- [x] Created type definitions
- [x] Added AdapterType enum
- [ ] Defined PaymentAdapter interface

## Lines Changed
- Current: 150/300
- Files: 2

## Next Steps
- Define remaining interfaces
- Add type guards

## Blockers
- None

## Security Notes
- All token types include encryption flag
- Added overflow protection to amount types
```

## Final Checklist Before PR

1. **Code Quality**
   - [ ] Every function has complete JSDoc
   - [ ] No `any` types used
   - [ ] All errors handled
   - [ ] No console.log statements
   - [ ] No commented-out code

2. **Security**
   - [ ] No secrets in code
   - [ ] Input validation everywhere
   - [ ] Encryption for sensitive data
   - [ ] Rate limiting considered
   - [ ] Audit logging added

3. **Testing**
   - [ ] Unit tests written
   - [ ] Tests pass locally
   - [ ] Edge cases covered
   - [ ] Security tests included

4. **Documentation**
   - [ ] README updated if needed
   - [ ] API docs current
   - [ ] Migration guide if breaking changes
   - [ ] Security implications noted

## Remember

1. **Small PRs**: Better to have 50 PRs of 100 lines than 5 PRs of 1000 lines
2. **Security First**: Every line of code handles user funds
3. **Test Everything**: Untested code is broken code
4. **Document Why**: Code shows what, comments explain why
5. **Ask Questions**: When in doubt, ask for clarification

The Smart Router is a critical feature handling user funds. Take your time, be thorough, and prioritize security over speed. 