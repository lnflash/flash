# Cashier Role API Design

## GraphQL Schema Extensions

### New Types

```graphql
enum UserRole {
  USER
  CASHIER
  ADMIN
}

enum CashierPermission {
  VIEW_TRANSACTIONS
  PROCESS_DEPOSITS
  PROCESS_WITHDRAWALS
  VIEW_USER_BALANCES
  GENERATE_REPORTS
}

type CashierInfo {
  accountId: ID!
  role: UserRole!
  permissions: [CashierPermission!]!
  assignedAt: Timestamp!
  assignedBy: Account
}

type AuditLog {
  id: ID!
  cashierId: ID!
  action: String!
  targetUserId: ID
  transactionId: ID
  amount: SignedAmount
  timestamp: Timestamp!
  metadata: JSON
}
```

### Cashier-Specific Queries

```graphql
extend type Query {
  # Cashier can view user transactions
  cashierViewUserTransactions(
    userId: ID!
    first: Int
    after: String
  ): TransactionConnection! @requiresRole(role: CASHIER)
  
  # Cashier can search transactions
  cashierSearchTransactions(
    filter: TransactionFilter!
    first: Int
    after: String
  ): TransactionConnection! @requiresRole(role: CASHIER)
  
  # Get cashier's own activity log
  cashierActivityLog(
    first: Int
    after: String
  ): AuditLogConnection! @requiresRole(role: CASHIER)
  
  # View user account details (limited info)
  cashierViewUserAccount(userId: ID!): UserAccountInfo! @requiresRole(role: CASHIER)
}
```

### Cashier-Specific Permissions

Cashiers will have permissions to access existing mutations and queries with additional authorization checks:

```graphql
# Cashiers can use existing mutations with permission checks:
# - Standard payment mutations with cashier context logging
# - Transaction queries with extended filters
# - Report generation through existing analytics endpoints
```

The cashier role will be enforced at the resolver level using graphql-shield rules to ensure proper authorization and audit logging for all operations.

### Admin Mutations for Role Management

```graphql
extend type Mutation {
  # Assign cashier role
  adminAssignCashierRole(
    userId: ID!
    permissions: [CashierPermission!]!
  ): CashierInfo! @requiresRole(role: ADMIN)
  
  # Remove cashier role
  adminRevokeCashierRole(userId: ID!): Account! @requiresRole(role: ADMIN)
  
  # Update cashier permissions
  adminUpdateCashierPermissions(
    userId: ID!
    permissions: [CashierPermission!]!
  ): CashierInfo! @requiresRole(role: ADMIN)
}
```

## REST API Endpoints (Alternative/Supplementary)

### Cashier Operations
- `GET /api/cashier/transactions/:userId` - View user transactions (with permission check)
- `GET /api/cashier/audit-log` - Get cashier's activity log

### Admin Operations
- `POST /api/admin/roles/assign-cashier` - Assign cashier role
- `DELETE /api/admin/roles/revoke-cashier/:userId` - Revoke cashier role
- `PUT /api/admin/roles/update-permissions/:userId` - Update permissions

## Security Headers

All cashier endpoints require:
- `Authorization: Bearer <JWT_TOKEN>`
- `X-Cashier-Session-Id: <SESSION_ID>` (for audit tracking)

## Rate Limiting

Cashier operations have specific rate limits:
- Transaction views: 100 per minute
- Report generation: 5 per hour
- All payment operations follow standard rate limits with cashier context

## Audit Requirements

Every cashier action must log:
- Cashier account ID
- Action type
- Target user (if applicable)
- Transaction details
- Timestamp
- IP address
- Session ID