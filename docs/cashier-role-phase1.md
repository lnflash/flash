# Cashier Role Implementation - Phase 1

## Phase 1: Foundation - Detailed Plan

### 1. Analyze Existing Authentication and Role System

#### Current System Analysis
- **Authentication Flow**:
  - JWT tokens stored in Redis
  - Token validation through Kratos/Oathkeeper
  - Session management with 5-15 minute token expiry
  
- **User Model Investigation**:
  - Location: `src/domain/accounts/` and `src/services/mongoose/accounts.ts`
  - Current fields: account status, level, limits
  - **Existing role system found**: Simple string enum (user, editor, dealer, bankowner, funder)
  - Role stored in Account model as `role` field
  - Admin access controlled via `isEditor` computed property

- **Key Files to Analyze**:
  - `/src/app/authentication/login.ts` - Main login logic
  - `/src/servers/middlewares/session.ts` - Session handling with JWT context
  - `/src/services/oathkeeper/index.ts` - Token validation
  - `/src/servers/graphql-admin-server.ts` - Admin permission checking
  - `/src/domain/accounts/primitives.ts` - AccountRoles constant
  - `/src/services/mongoose/schema.ts` - Database schemas

### 2. Design Cashier Role Permissions Schema

#### Role Hierarchy Design
```typescript
// Extend existing AccountRole enum
export const AccountRole = {
  User: "user",
  Editor: "editor",
  Dealer: "dealer",
  BankOwner: "bankowner",
  Funder: "funder",
  Cashier: "cashier", // NEW ROLE
} as const

enum CashierPermission {
  VIEW_TRANSACTIONS = "VIEW_TRANSACTIONS",
  PROCESS_DEPOSITS = "PROCESS_DEPOSITS",
  PROCESS_WITHDRAWALS = "PROCESS_WITHDRAWALS",
  VIEW_USER_BALANCES = "VIEW_USER_BALANCES",
  GENERATE_REPORTS = "GENERATE_REPORTS"
}
```

#### Database Schema Updates
```typescript
// Account Schema Extension (src/services/mongoose/schema.ts)
const AccountSchema = new Schema<AccountRecord>({
  // Existing fields...
  role: {
    type: String,
    enum: Object.values(AccountRole),
    required: true,
    default: AccountRole.User,
  },
  // NEW: Cashier-specific fields
  cashierPermissions: [{
    type: String,
    enum: Object.values(CashierPermission),
  }],
  roleHistory: [{
    role: String,
    assignedAt: Date,
    assignedBy: String,
    revokedAt: Date,
  }],
})
```

### 3. Implement RBAC Middleware

#### Middleware Components
1. **Role Verification Middleware**
   - Location: `/src/servers/middlewares/role-auth.ts` (NEW FILE)
   - Extend existing session middleware to include role checks
   - Use graphql-shield for declarative authorization
   - Pattern similar to existing `isEditor` checks

2. **Permission Check Middleware**
   - Location: `/src/servers/middlewares/permission-check.ts`
   - Granular permission validation
   - Caches permissions in Redis for performance

3. **Audit Logger Middleware**
   - Location: `/src/servers/middlewares/audit-logger.ts`
   - Logs all cashier actions
   - Stores in PostgreSQL audit table

#### Implementation Tasks

##### Task 1.1: Analyze Authentication System ✅ COMPLETED
- [x] Reviewed Kratos/Oathkeeper integration
- [x] JWT validated via JWKS with `sub` claim containing user ID
- [x] Authentication flow: Kratos → Oathkeeper → Application
- [x] Extension points identified:
  - Account model has existing `role` field
  - graphql-shield already used for authorization
  - Session middleware loads account with role

##### Task 1.2: Design Role Schema
- [ ] Create TypeScript interfaces for roles
- [ ] Design MongoDB schema updates
- [ ] Plan migration strategy
- [ ] Define permission matrix

##### Task 1.3: Build RBAC Middleware
- [ ] Create role validation middleware
- [ ] Implement permission checking
- [ ] Add audit logging hooks
- [ ] Integration with existing auth flow

## Implementation Guide

### Step 1: Extend Account Model

1. **Update Domain Types** (`src/domain/accounts/index.types.d.ts`):
```typescript
export const CashierPermission = {
  ViewTransactions: "VIEW_TRANSACTIONS",
  ProcessDeposits: "PROCESS_DEPOSITS", 
  ProcessWithdrawals: "PROCESS_WITHDRAWALS",
  ViewUserBalances: "VIEW_USER_BALANCES",
  GenerateReports: "GENERATE_REPORTS"
} as const

export type CashierPermission = typeof CashierPermission[keyof typeof CashierPermission]
```

2. **Update Mongoose Schema** (`src/services/mongoose/schema.ts`):
- Add cashierPermissions array to AccountSchema
- Add roleHistory for audit trail
- Update role enum to include "cashier"

3. **Create Role Checker** (`src/domain/accounts/role-checker.ts`):
```typescript
export const RoleChecker = {
  isCashier: (account: Account): boolean => 
    account.role === AccountRole.Cashier,
  
  hasPermission: (account: Account, permission: CashierPermission): boolean =>
    account.role === AccountRole.Cashier && 
    account.cashierPermissions?.includes(permission),
    
  canAccessCashierFeatures: (account: Account): boolean =>
    [AccountRole.Cashier, AccountRole.Editor, AccountRole.BankOwner]
      .includes(account.role)
}
```

### Step 2: Create Authorization Rules

1. **Install graphql-shield** (already available)
2. **Create Cashier Rules** (`src/servers/authorization/cashier-rules.ts`):
```typescript
import { rule, shield } from "graphql-shield"

export const isCashier = rule({ cache: "contextual" })(
  async (parent, args, { domainAccount }) => {
    return RoleChecker.isCashier(domainAccount)
  }
)

export const hasPermission = (permission: CashierPermission) =>
  rule({ cache: "contextual" })(
    async (parent, args, { domainAccount }) => {
      return RoleChecker.hasPermission(domainAccount, permission)
    }
  )
```

### Step 3: Extend Session Context

1. **Update Session Middleware** (`src/servers/middlewares/session.ts`):
- Load cashierPermissions when fetching account
- Add permission helpers to context

2. **Update GraphQL Context Type**:
```typescript
interface GraphQLContextForUser {
  // Existing fields...
  isCashier: boolean
  cashierPermissions: CashierPermission[]
  hasPermission: (permission: CashierPermission) => boolean
}
```

### Step 4: Database Migration

Create migration script (`src/migrations/[timestamp]-add-cashier-role.ts`):
```typescript
export const up = async () => {
  // Add cashierPermissions field to all accounts
  await Account.updateMany(
    {},
    { $set: { cashierPermissions: [] } }
  )
  
  // Initialize roleHistory for existing roles
  const accounts = await Account.find({ role: { $ne: "user" } })
  for (const account of accounts) {
    await account.updateOne({
      $set: {
        roleHistory: [{
          role: account.role,
          assignedAt: account.createdAt,
          assignedBy: "system-migration"
        }]
      }
    })
  }
}
```

## Next Steps
After completing Phase 1 foundation work:
1. Test RBAC middleware with existing endpoints
2. Create migration scripts for database updates
3. Begin Phase 2 with cashier-specific GraphQL operations
4. Implement audit logging for all cashier actions