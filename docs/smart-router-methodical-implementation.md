# Smart Router Methodical Implementation Guide

## 🤖 AI Agent Instructions - READ THIS FIRST

This guide provides a security-first, methodical approach to implementing the Smart Router feature. The implementation MUST be slow, deliberate, and extensively documented to ensure security and maintainability.

### Core Principles
1. **Go Slow**: Each change should be minimal and focused (max 200-300 lines per PR)
2. **Document Everything**: Every function, type, and decision must be documented
3. **Test First**: Write tests before implementation when possible
4. **Security First**: Consider security implications of every change
5. **Human Review**: Create small, digestible PRs for each milestone

### Commenting Standards
```typescript
/**
 * SMART_ROUTER: [Component Name]
 * 
 * Purpose: [What this code does]
 * Security: [Security considerations]
 * Dependencies: [What this depends on]
 * Side Effects: [Any side effects]
 * Performance: [Performance considerations]
 * 
 * @example
 * // Example usage here
 * 
 * @since smart-router-v1
 * @security-review pending|approved
 * @milestone X
 */
```

## Executive Summary

The Smart Router creates a unified "Cash" wallet that intelligently manages funds across multiple sources:
- **IBEX Lightning**: Existing custodial Lightning integration
- **eCash (Cashu)**: Offline-capable bearer tokens
- **Future Custodians**: Extensible architecture for Strike, etc.

**Total Implementation Timeline**: 16-20 weeks (broken into 30+ small PRs)

## Detailed Milestone Breakdown

### 🎯 Milestone 1: Type Definitions and Domain Model (PR #1-2)
**Goal**: Define all TypeScript types and interfaces for Smart Router
**Timeline**: 3-4 days
**Lines**: ~200-250 per PR

#### PR #1: Core Types and Enums
```typescript
// src/domain/cash-wallet/index.types.d.ts
/**
 * SMART_ROUTER: Implementation Plan for Milestone 1
 * 
 * Files to create:
 * 1. src/domain/cash-wallet/index.types.d.ts - Core type definitions
 * 2. src/domain/cash-wallet/errors.ts - Error types and classes
 * 
 * Security considerations:
 * - All token data types must support encryption
 * - Balance types must prevent overflow
 * - Route types must include security metadata
 * 
 * @milestone 1
 * @estimated-loc 200
 * @security-impact low
 */
```

Tasks:
- [ ] Create `AdapterType` enum (IBEX, CASHU, FUTURE)
- [ ] Define `PaymentAdapter` interface
- [ ] Create `CashBalance` type with breakdown
- [ ] Define `PaymentRoute` and routing types
- [ ] Add `CashuToken` and proof types
- [ ] Create branded types for type safety

#### PR #2: Error Types and Domain Constants
- [ ] Create comprehensive error hierarchy
- [ ] Define adapter capabilities enum
- [ ] Add routing strategy types
- [ ] Create security-related constants
- [ ] Define vault encryption types

### 🎯 Milestone 2: Base Infrastructure (PR #3-5)
**Goal**: Create foundational classes without implementation
**Timeline**: 1 week
**Lines**: ~150-200 per PR

#### PR #3: Abstract Base Classes
- [ ] Create `BasePaymentAdapter` abstract class
- [ ] Define adapter lifecycle methods
- [ ] Add adapter registration system
- [ ] Create adapter factory pattern
- [ ] Implement adapter validation

#### PR #4: Secure Storage Foundation
- [ ] Create `SecureStorage` interface
- [ ] Define encryption service interface
- [ ] Add platform-specific storage types
- [ ] Create storage migration types
- [ ] Define backup/restore interfaces

#### PR #5: Event System and Logging
- [ ] Create event emitter for cash wallet
- [ ] Define audit log types
- [ ] Add transaction state machine
- [ ] Create performance monitoring hooks
- [ ] Define telemetry interfaces

### 🎯 Milestone 3: IBEX Adapter (PR #6-8)
**Goal**: Implement IBEX adapter using existing integration
**Timeline**: 1 week
**Lines**: ~200-250 per PR

#### PR #6: IBEX Adapter Structure
- [ ] Create `IbexAdapter` class skeleton
- [ ] Implement adapter interface methods
- [ ] Add IBEX-specific types
- [ ] Create configuration system
- [ ] Add health check methods

#### PR #7: IBEX Balance and Query Operations
- [ ] Implement balance fetching
- [ ] Add transaction history queries
- [ ] Create balance caching layer
- [ ] Add balance validation
- [ ] Implement sync mechanism

#### PR #8: IBEX Payment Operations
- [ ] Implement Lightning invoice creation
- [ ] Add payment execution logic
- [ ] Create payment monitoring
- [ ] Add fee calculation
- [ ] Implement error recovery

### 🎯 Milestone 4: Local Vault Foundation (PR #9-12)
**Goal**: Create secure storage for Cashu tokens
**Timeline**: 2 weeks
**Lines**: ~200-250 per PR

#### PR #9: Vault Architecture
- [ ] Create `LocalCashVault` class structure
- [ ] Define storage schema
- [ ] Add vault initialization
- [ ] Create vault migrations
- [ ] Implement vault locking

#### PR #10: Encryption Layer
- [ ] Implement platform-specific encryption
- [ ] Add key derivation functions
- [ ] Create encryption service
- [ ] Add secure key storage
- [ ] Implement key rotation

#### PR #11: Token Storage Operations
- [ ] Implement token storage methods
- [ ] Add token retrieval functions
- [ ] Create token indexing system
- [ ] Add token validation
- [ ] Implement spent token tracking

#### PR #12: Vault Security and Backup
- [ ] Add vault backup functionality
- [ ] Implement restore operations
- [ ] Create integrity checks
- [ ] Add anti-tampering measures
- [ ] Implement secure deletion

### 🎯 Milestone 5: Cashu Protocol Types (PR #13-14)
**Goal**: Define Cashu protocol implementation types
**Timeline**: 3-4 days
**Lines**: ~150-200 per PR

#### PR #13: Cashu Protocol Types
- [ ] Define mint communication types
- [ ] Create token structure types
- [ ] Add proof validation types
- [ ] Define mint capability types
- [ ] Create protocol error types

#### PR #14: Mint Registry Types
- [ ] Create mint configuration types
- [ ] Define mint health check types
- [ ] Add mint validation types
- [ ] Create mint selection types
- [ ] Define federation types

### 🎯 Milestone 6: Cashu Adapter Foundation (PR #15-18)
**Goal**: Implement Cashu adapter without mint communication
**Timeline**: 2 weeks
**Lines**: ~200-250 per PR

#### PR #15: Cashu Adapter Structure
- [ ] Create `CashuAdapter` class
- [ ] Implement adapter interface
- [ ] Add token management structure
- [ ] Create adapter configuration
- [ ] Define adapter state

#### PR #16: Token Selection Algorithm
- [ ] Implement coin selection logic
- [ ] Add optimization strategies
- [ ] Create selection preferences
- [ ] Add fee minimization
- [ ] Implement change calculation

#### PR #17: Token Operations
- [ ] Implement token splitting
- [ ] Add token merging logic
- [ ] Create token validation
- [ ] Add proof generation
- [ ] Implement token refresh

#### PR #18: Offline Capabilities
- [ ] Add offline token validation
- [ ] Implement offline balance tracking
- [ ] Create sync queue for offline ops
- [ ] Add conflict resolution
- [ ] Implement offline recovery

### 🎯 Milestone 7: Mint Communication (PR #19-22)
**Goal**: Implement mint client and communication
**Timeline**: 2 weeks
**Lines**: ~200-250 per PR

#### PR #19: Mint Client Foundation
- [ ] Create `MintClient` class
- [ ] Add HTTP communication layer
- [ ] Implement request signing
- [ ] Add response validation
- [ ] Create retry logic

#### PR #20: Mint Protocol Implementation
- [ ] Implement mint info fetching
- [ ] Add token minting operations
- [ ] Create token melting (redeem)
- [ ] Add split operations
- [ ] Implement key rotation handling

#### PR #21: Mint Registry Service
- [ ] Create `MintRegistry` service
- [ ] Implement mint discovery
- [ ] Add mint validation
- [ ] Create mint health monitoring
- [ ] Implement mint switching

#### PR #22: Mint Security and Testing
- [ ] Add mint certificate validation
- [ ] Implement anti-replay protection
- [ ] Create mint communication tests
- [ ] Add integration test fixtures
- [ ] Implement mock mint for testing

### 🎯 Milestone 8: Cash Wallet Manager Core (PR #23-26)
**Goal**: Create central orchestration layer
**Timeline**: 2 weeks
**Lines**: ~250-300 per PR

#### PR #23: Manager Architecture
- [ ] Create `CashWalletManager` class
- [ ] Add adapter management
- [ ] Create state management
- [ ] Implement initialization
- [ ] Add configuration system

#### PR #24: Balance Aggregation
- [ ] Implement balance fetching
- [ ] Add balance aggregation logic
- [ ] Create balance caching
- [ ] Add real-time updates
- [ ] Implement balance validation

#### PR #25: Transaction Orchestration
- [ ] Create transaction coordinator
- [ ] Add transaction state machine
- [ ] Implement rollback logic
- [ ] Add transaction persistence
- [ ] Create transaction monitoring

#### PR #26: Sync Manager
- [ ] Create `SyncManager` service
- [ ] Implement sync scheduling
- [ ] Add conflict resolution
- [ ] Create sync optimization
- [ ] Implement background sync

### 🎯 Milestone 9: Routing Engine (PR #27-30)
**Goal**: Implement intelligent payment routing
**Timeline**: 2 weeks
**Lines**: ~250-300 per PR

#### PR #27: Routing Engine Core
- [ ] Create `RoutingEngine` class
- [ ] Define routing strategies
- [ ] Add route generation logic
- [ ] Create route scoring system
- [ ] Implement route caching

#### PR #28: Single-Source Routing
- [ ] Implement direct payment routing
- [ ] Add adapter selection logic
- [ ] Create fee optimization
- [ ] Add capability matching
- [ ] Implement fallback logic

#### PR #29: Multi-Source Routing
- [ ] Implement split payment logic
- [ ] Add payment coordination
- [ ] Create atomic operations
- [ ] Add partial payment handling
- [ ] Implement rollback mechanisms

#### PR #30: Cashu-to-Lightning Swaps
- [ ] Design swap flow architecture
- [ ] Implement swap execution
- [ ] Add swap monitoring
- [ ] Create swap recovery
- [ ] Add swap fee calculation

### 🎯 Milestone 10: GraphQL Integration (PR #31-33)
**Goal**: Integrate with existing GraphQL API
**Timeline**: 1 week
**Lines**: ~200-250 per PR

#### PR #31: GraphQL Schema Updates
- [ ] Add cash wallet types to schema
- [ ] Create new queries
- [ ] Define mutations
- [ ] Add subscriptions
- [ ] Update existing types

#### PR #32: Resolver Implementation
- [ ] Implement query resolvers
- [ ] Add mutation resolvers
- [ ] Create subscription resolvers
- [ ] Add field resolvers
- [ ] Implement error handling

#### PR #33: GraphQL Security
- [ ] Add permission checks
- [ ] Implement rate limiting
- [ ] Add input validation
- [ ] Create audit logging
- [ ] Add query complexity limits

### 🎯 Milestone 11: Database Integration (PR #34-35)
**Goal**: Add persistence layer
**Timeline**: 1 week
**Lines**: ~200-250 per PR

#### PR #34: Schema and Migrations
- [ ] Create MongoDB schemas
- [ ] Add migration scripts
- [ ] Create indexes
- [ ] Add data validation
- [ ] Implement versioning

#### PR #35: Repository Pattern
- [ ] Create repository interfaces
- [ ] Implement MongoDB repositories
- [ ] Add caching layer
- [ ] Create transaction support
- [ ] Add query optimization

### 🎯 Milestone 12: Security Hardening (PR #36-37)
**Goal**: Comprehensive security implementation
**Timeline**: 1 week
**Lines**: ~200-250 per PR

#### PR #36: Security Services
- [ ] Implement token encryption
- [ ] Add secure key management
- [ ] Create audit logging service
- [ ] Add intrusion detection
- [ ] Implement rate limiting

#### PR #37: Security Validation
- [ ] Add input sanitization
- [ ] Implement CSRF protection
- [ ] Create security headers
- [ ] Add vulnerability scanning
- [ ] Implement security tests

### 🎯 Milestone 13: Testing Suite (PR #38-40)
**Goal**: Comprehensive test coverage
**Timeline**: 2 weeks
**Lines**: ~300+ per PR

#### PR #38: Unit Tests
- [ ] Test payment adapters
- [ ] Test vault operations
- [ ] Test routing engine
- [ ] Test token operations
- [ ] Test security functions

#### PR #39: Integration Tests
- [ ] Test adapter integration
- [ ] Test mint communication
- [ ] Test payment flows
- [ ] Test sync operations
- [ ] Test error scenarios

#### PR #40: E2E Tests
- [ ] Test complete user flows
- [ ] Test multi-device scenarios
- [ ] Test offline/online transitions
- [ ] Test recovery scenarios
- [ ] Test performance under load

## Security Checkpoints

### After Each Major Component:
1. **Threat Modeling**: Review attack vectors
2. **Code Audit**: Security-focused code review
3. **Penetration Testing**: Test security measures
4. **Performance Testing**: Ensure no DoS vulnerabilities
5. **Compliance Check**: Verify regulatory compliance

## PR Review Criteria

### Every PR Must Include:

1. **Code Quality**
   - [ ] All functions have security-focused JSDoc
   - [ ] No hardcoded values
   - [ ] Comprehensive error handling
   - [ ] Input validation everywhere
   - [ ] No debug code

2. **Security Review**
   - [ ] No sensitive data in logs
   - [ ] Encryption used for sensitive data
   - [ ] Authentication checks present
   - [ ] Authorization verified
   - [ ] Rate limiting considered

3. **Testing**
   - [ ] Unit tests >90% coverage
   - [ ] Integration tests for new features
   - [ ] Security test cases
   - [ ] Performance benchmarks
   - [ ] Edge case handling

4. **Documentation**
   - [ ] Code explains "why" not just "what"
   - [ ] Security implications documented
   - [ ] Performance considerations noted
   - [ ] Migration guide if needed
   - [ ] API documentation updated

## Implementation Guidelines for AI Agents

### Before Starting ANY Work:

1. **Read ALL Documentation**:
   - [ ] This methodical guide
   - [ ] Smart Router overview
   - [ ] Architecture document
   - [ ] Security specification
   - [ ] API design document

2. **Analyze Existing Code**:
   - [ ] Study payment processing in Flash
   - [ ] Understand Lightning integration
   - [ ] Review authentication system
   - [ ] Examine GraphQL patterns

3. **Security Mindset**:
   - Every line could be a vulnerability
   - Assume all input is malicious
   - Encrypt sensitive data always
   - Log security events
   - Validate everything

### Common Pitfalls to Avoid:
1. **DON'T** implement features not in the current milestone
2. **DON'T** skip error handling to save time
3. **DON'T** use `any` type - always define proper types
4. **DON'T** store sensitive data unencrypted
5. **DON'T** trust external data without validation
6. **DON'T** make assumptions about mint behavior
7. **DON'T** ignore offline scenarios

### Git Workflow:
```bash
# For each PR
git checkout -b smart-router/milestone-X-description
# Make minimal changes
git add -p  # Review each change
git commit -m "SMART_ROUTER: [Specific change description]"
# Ensure < 300 lines changed
git diff origin/feature/smart-router --stat
```

## Success Metrics

- Zero security vulnerabilities
- >95% test coverage
- <2% code churn post-deployment
- All PRs under 300 lines
- 100% documented functions

## Timeline Summary

- **Phase 1** (Milestones 1-4): Foundation - 4 weeks
- **Phase 2** (Milestones 5-8): Core Implementation - 6 weeks  
- **Phase 3** (Milestones 9-11): Integration - 4 weeks
- **Phase 4** (Milestones 12-13): Hardening - 3 weeks

**Total**: 17 weeks of implementation + 3 weeks buffer = 20 weeks

Remember: **Security and quality over speed**. This feature handles user funds and must be bulletproof. 