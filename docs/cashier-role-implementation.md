# Cashier Role Implementation

## 🤖 Implementation Guidelines for AI Agents and Developers

### Core Principles
1. **Go Slow**: Each change should be minimal and focused
2. **Document Everything**: Every function, type, and decision must be documented
3. **Test First**: Write tests before implementation when possible
4. **Security First**: Consider security implications of every change
5. **Human Review**: Create small, digestible PRs for each milestone

### Commenting Standards
```typescript
/**
 * CASHIER_ROLE: [Component Name]
 * 
 * Purpose: [What this code does]
 * Security: [Security considerations]
 * Dependencies: [What this depends on]
 * Side Effects: [Any side effects]
 * 
 * @example
 * // Example usage here
 * 
 * @since cashier-role-v1
 * @security-review pending|approved
 */
```

### Milestone-Based PR Strategy

Each milestone should be a separate PR with:
- Maximum 200-300 lines of code change
- Complete unit tests
- Updated documentation
- Security review checklist
- No breaking changes to existing functionality

### AI Agent Instructions

When implementing this feature:
1. Read ALL related documentation before making changes
2. Use `git diff` frequently to verify changes are minimal
3. Add `CASHIER_ROLE:` prefix to all commit messages
4. Create a checklist comment in each file you modify
5. Never skip error handling or validation
6. Always consider backwards compatibility

📖 **Detailed AI Implementation Guide**: See [cashier-role-ai-implementation-guide.md](./cashier-role-ai-implementation-guide.md) for step-by-step instructions.

## Overview
This document tracks the implementation of the Cashier Role feature for the Flash Bitcoin Banking Platform. The feature extends the existing authentication system to support role-based access control (RBAC) for cashier operations.

### 📚 Implementation Approach Documents
- **[Methodical Implementation Approach](./cashier-role-methodical-approach.md)** - Overview of our security-first, milestone-based approach
- **[AI Implementation Guide](./cashier-role-ai-implementation-guide.md)** - Detailed instructions for AI agents implementing features

## Technical Stack
- Backend: Node.js with TypeScript
- API: GraphQL (Apollo Server)
- Databases: MongoDB, Redis, PostgreSQL
- Authentication: JWT-based with Kratos/Oathkeeper
- Bitcoin Integration: LND, Bitcoin Core

## Implementation Status

### Phase 1: Foundation ✅ In Progress
- [ ] Analyze existing authentication and role system
- [ ] Design cashier role permissions and access control schema
- [ ] Implement role-based access control (RBAC) middleware

### Phase 2: Core Features
- [ ] Add cashier-specific GraphQL queries for viewing data
- [ ] Implement cashier transaction logging and audit trail
- [ ] Add cashier role management to admin interface
- [ ] Extend existing API endpoints with cashier permissions

### Phase 3: Enhancement & Polish
- [ ] Implement cashier session management with Redis
- [ ] Add comprehensive tests for cashier role functionality
- [ ] Update API documentation for cashier endpoints

## Detailed Milestone Breakdown

### 🎯 Milestone 1: Type Definitions and Interfaces (PR #1)
**Goal**: Define all TypeScript types and interfaces for cashier role
**Files**: ~50-100 lines
- [ ] Create `src/domain/cashier/index.types.d.ts`
- [ ] Add CashierRole enum value
- [ ] Define CashierPermission types
- [ ] Add CashierSession interface
- [ ] Update Account interface with cashier fields
- [ ] Create comprehensive JSDoc comments

### 🎯 Milestone 2: Database Schema Updates (PR #2)
**Goal**: Update Mongoose schemas without breaking existing data
**Files**: ~100-150 lines
- [ ] Backup existing Account schema
- [ ] Add cashierPermissions field to AccountSchema
- [ ] Add roleHistory tracking
- [ ] Create migration script
- [ ] Add schema validation tests
- [ ] Document rollback procedure

### 🎯 Milestone 3: Domain Logic for Role Checking (PR #3)
**Goal**: Implement pure functions for role validation
**Files**: ~150-200 lines
- [ ] Create `src/domain/cashier/role-checker.ts`
- [ ] Implement isCashier() function
- [ ] Implement hasPermission() function
- [ ] Add permission inheritance logic
- [ ] Create comprehensive unit tests
- [ ] Add error handling for edge cases

### 🎯 Milestone 4: GraphQL Type Definitions (PR #4)
**Goal**: Extend GraphQL schema with cashier types
**Files**: ~100-150 lines
- [ ] Add CashierRole to GraphQL enums
- [ ] Define CashierPermission enum
- [ ] Create CashierInfo type
- [ ] Add audit-related types
- [ ] Update existing User type
- [ ] Generate TypeScript types

### 🎯 Milestone 5: Authorization Rules with graphql-shield (PR #5)
**Goal**: Implement authorization rules without breaking existing ones
**Files**: ~150-200 lines
- [ ] Create `src/servers/authorization/cashier-rules.ts`
- [ ] Implement isCashier rule
- [ ] Implement permission-based rules
- [ ] Add rule composition helpers
- [ ] Create integration tests
- [ ] Document rule precedence

### 🎯 Milestone 6: Session Context Enhancement (PR #6)
**Goal**: Extend GraphQL context with cashier information
**Files**: ~100-150 lines
- [ ] Update session middleware
- [ ] Add cashier permission loading
- [ ] Implement permission caching
- [ ] Add context type updates
- [ ] Create middleware tests
- [ ] Performance benchmark

### 🎯 Milestone 7: Audit Logging Infrastructure (PR #7)
**Goal**: Create audit logging system for cashier actions
**Files**: ~200-250 lines
- [ ] Create audit log schema
- [ ] Implement audit logger service
- [ ] Add PostgreSQL integration
- [ ] Create audit log middleware
- [ ] Add retention policies
- [ ] Implement log querying

### 🎯 Milestone 8: First GraphQL Query - View Transactions (PR #8)
**Goal**: Implement first cashier-specific query
**Files**: ~150-200 lines
- [ ] Create resolver for cashierViewUserTransactions
- [ ] Add authorization checks
- [ ] Implement audit logging
- [ ] Add input validation
- [ ] Create integration tests
- [ ] Add rate limiting

### 🎯 Milestone 9: Admin Role Management Mutations (PR #9)
**Goal**: Allow admins to assign/revoke cashier roles
**Files**: ~200-250 lines
- [ ] Implement assignCashierRole mutation
- [ ] Implement revokeCashierRole mutation
- [ ] Add permission update mutation
- [ ] Create role history tracking
- [ ] Add notification system
- [ ] Comprehensive testing

### 🎯 Milestone 10: PIN Authentication - Types and Schema (PR #10)
**Goal**: Add PIN-related types and database fields
**Files**: ~100-150 lines
- [ ] Add PIN fields to Account schema
- [ ] Create PIN-related types
- [ ] Add session types for PIN auth
- [ ] Create migration script
- [ ] Document security model
- [ ] Add validation rules

### 🎯 Milestone 11: PIN Setup and Management (PR #11)
**Goal**: Implement PIN setup and change functionality
**Files**: ~200-250 lines
- [ ] Create PIN hashing service
- [ ] Implement setupPin mutation
- [ ] Implement changePin mutation
- [ ] Add PIN validation rules
- [ ] Create security tests
- [ ] Add rate limiting

### 🎯 Milestone 12: PIN Login Implementation (PR #12)
**Goal**: Implement PIN-based login flow
**Files**: ~250-300 lines
- [ ] Create loginWithPin mutation
- [ ] Implement session creation
- [ ] Add failed attempt tracking
- [ ] Implement account locking
- [ ] Create comprehensive tests
- [ ] Add monitoring hooks

### 🎯 Milestone 13: Session Management with Redis (PR #13)
**Goal**: Implement Redis-based session management
**Files**: ~200-250 lines
- [ ] Create session service
- [ ] Implement session storage
- [ ] Add session expiry logic
- [ ] Create session queries
- [ ] Add cleanup jobs
- [ ] Performance testing

### 🎯 Milestone 14: Integration Tests Suite (PR #14)
**Goal**: Comprehensive integration testing
**Files**: ~300+ lines
- [ ] Create test scenarios
- [ ] Implement end-to-end tests
- [ ] Add security test cases
- [ ] Create load tests
- [ ] Document test coverage
- [ ] CI/CD integration

### 🎯 Milestone 15: Documentation and API Reference (PR #15)
**Goal**: Complete documentation update
**Files**: Documentation only
- [ ] Update API documentation
- [ ] Create usage examples
- [ ] Add troubleshooting guide
- [ ] Create admin guide
- [ ] Update security documentation
- [ ] Add migration guide

## PR Review Criteria

### Every PR Must Include:

1. **Code Quality Checklist**
   - [ ] All functions have JSDoc comments with security notes
   - [ ] No hardcoded values or magic numbers
   - [ ] Error handling for all edge cases
   - [ ] Input validation on all external inputs
   - [ ] No console.log or debug statements

2. **Security Review Checklist**
   - [ ] No sensitive data in logs
   - [ ] Authentication checks present
   - [ ] Authorization rules tested
   - [ ] Rate limiting considered
   - [ ] SQL injection prevention (if applicable)
   - [ ] XSS prevention (if applicable)

3. **Testing Requirements**
   - [ ] Unit tests with >90% coverage
   - [ ] Integration tests for new features
   - [ ] Security test cases included
   - [ ] Performance impact measured
   - [ ] Breaking change assessment

4. **Documentation Updates**
   - [ ] Code comments explain "why" not just "what"
   - [ ] README updated if needed
   - [ ] API documentation current
   - [ ] Security implications documented
   - [ ] Migration notes if applicable

### Security Checkpoints

Before each milestone can be merged:

1. **Milestone 1-3**: Foundation Security Review
   - Threat model for cashier role
   - Permission model validation
   - Data flow analysis

2. **Milestone 4-6**: Authorization Security Review
   - GraphQL authorization audit
   - Context isolation verification
   - Permission inheritance check

3. **Milestone 7-9**: Audit and Admin Security Review
   - Audit log tampering prevention
   - Admin action validation
   - Role assignment security

4. **Milestone 10-12**: PIN Authentication Security Review
   - PIN storage security audit
   - Brute force prevention
   - Session hijacking prevention

5. **Milestone 13-15**: Final Security Review
   - Penetration testing
   - Performance under load
   - Complete security audit

## Architecture Decisions
- Extend existing JWT authentication system
- Use MongoDB for role storage and persistence
- Implement audit logging in PostgreSQL for compliance
- Redis for session management and caching

## Security Considerations
- All cashier actions must be logged with timestamps
- Implement principle of least privilege
- Add rate limiting for cashier operations
- Ensure secure token handling and session management

## Key Features
- **Role-Based Access Control**: Cashiers have specific permissions for viewing transactions and generating reports
- **PIN Authentication**: Quick and secure login method for daily operations
- **Audit Trail**: Comprehensive logging of all cashier actions
- **Session Management**: Shift-based sessions with automatic expiry

## Related Documentation
- [Phase 1 Implementation Details](./cashier-role-phase1.md)
- [API Design](./cashier-role-api-design.md)
- [Testing Strategy](./cashier-role-testing.md)
- [Cashier Login Requirements](./cashier-login-requirements.md)
- [Login Flow Diagrams](./cashier-login-flow.md)
- [Login Implementation Guide](./cashier-login-implementation-guide.md)