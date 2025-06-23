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

### Cashier-Specific Mutations

```graphql
extend type Mutation {
  # Process cash deposit
  cashierProcessDeposit(input: CashDepositInput!): CashDepositPayload! 
    @requiresRole(role: CASHIER)
    @requiresPermission(permission: PROCESS_DEPOSITS)
  
  # Process cash withdrawal
  cashierProcessWithdrawal(input: CashWithdrawalInput!): CashWithdrawalPayload!
    @requiresRole(role: CASHIER)
    @requiresPermission(permission: PROCESS_WITHDRAWALS)
  
  # Generate transaction report
  cashierGenerateReport(input: ReportInput!): ReportPayload!
    @requiresRole(role: CASHIER)
    @requiresPermission(permission: GENERATE_REPORTS)
}

input CashDepositInput {
  userId: ID!
  amount: SignedAmount!
  reference: String!
  notes: String
}

input CashWithdrawalInput {
  userId: ID!
  amount: SignedAmount!
  reference: String!
  verificationCode: String!
  notes: String
}

type CashDepositPayload {
  success: Boolean!
  transaction: Transaction
  errors: [Error!]!
}

type CashWithdrawalPayload {
  success: Boolean!
  transaction: Transaction
  errors: [Error!]!
}
```

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
- `POST /api/cashier/deposit` - Process cash deposit
- `POST /api/cashier/withdrawal` - Process cash withdrawal
- `GET /api/cashier/transactions/:userId` - View user transactions
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

Cashier endpoints have specific rate limits:
- Deposits: 30 per minute
- Withdrawals: 20 per minute
- Transaction views: 100 per minute
- Report generation: 5 per hour

## Audit Requirements

Every cashier action must log:
- Cashier account ID
- Action type
- Target user (if applicable)
- Transaction details
- Timestamp
- IP address
- Session ID