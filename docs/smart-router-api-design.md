# Smart Router API Design

## GraphQL API Schema

### Queries

```graphql
extend type Query {
  """
  Get current cash wallet balance with detailed breakdown
  """
  cashWalletBalance: CashWalletBalance! @requiresAuth
  
  """
  List all registered mints for the user
  """
  cashWalletMints: CashWalletMintsPayload! @requiresAuth
  
  """
  Preview routing options for a payment
  """
  cashWalletRoutingPreview(
    amount: SignedAmount!
    destination: String!
    preferredRoute: RoutePreference
  ): RoutingPreview! @requiresAuth
  
  """
  Get cash wallet transaction history
  """
  cashWalletTransactions(
    first: Int
    after: String
    filter: CashWalletTransactionFilter
  ): CashWalletTransactionConnection! @requiresAuth
  
  """
  Get current vault status
  """
  cashWalletVaultStatus: VaultStatus! @requiresAuth
}
```

### Mutations

```graphql
extend type Mutation {
  """
  Send payment from cash wallet with automatic routing
  """
  cashWalletSend(
    input: CashWalletSendInput!
  ): CashWalletSendPayload! @requiresAuth
  
  """
  Receive payment into cash wallet (Lightning invoice or Cashu token)
  """
  cashWalletReceive(
    input: CashWalletReceiveInput!
  ): CashWalletReceivePayload! @requiresAuth
  
  """
  Create Lightning invoice for receiving into cash wallet
  """
  cashWalletCreateInvoice(
    input: CashWalletCreateInvoiceInput!
  ): CashWalletInvoicePayload! @requiresAuth
  
  """
  Add a new mint to the registry
  """
  cashWalletAddMint(
    url: String!
  ): CashWalletMintPayload! @requiresAuth
  
  """
  Set default mint for eCash operations
  """
  cashWalletSetDefaultMint(
    url: String!
  ): CashWalletMintPayload! @requiresAuth
  
  """
  Remove a mint from the registry
  """
  cashWalletRemoveMint(
    url: String!
  ): SuccessPayload! @requiresAuth
  
  """
  Create encrypted backup of cash wallet vault
  """
  cashWalletCreateBackup: CashWalletBackupPayload! @requiresAuth
  
  """
  Restore cash wallet from encrypted backup
  """
  cashWalletRestoreBackup(
    backup: String!
    password: String
  ): SuccessPayload! @requiresAuth
  
  """
  Consolidate small eCash tokens for efficiency
  """
  cashWalletConsolidateTokens(
    threshold: SignedAmount
  ): CashWalletConsolidatePayload! @requiresAuth
  
  """
  Manually sync cash wallet balances
  """
  cashWalletSync: CashWalletSyncPayload! @requiresAuth
}
```

### Types

```graphql
"""
Complete cash wallet balance information
"""
type CashWalletBalance {
  """Total balance across all sources"""
  total: SignedAmount!
  
  """Breakdown by custodial sources"""
  custodial: [CustodialBalance!]!
  
  """eCash balance details"""
  eCash: ECashBalance!
  
  """Last synchronization timestamp"""
  lastSync: Timestamp!
  
  """Indicates if any balance is pending"""
  hasPending: Boolean!
}

"""
Balance from a custodial source (e.g., IBEX)
"""
type CustodialBalance {
  """Unique identifier for the source"""
  sourceId: String!
  
  """Display name of the source"""
  sourceName: String!
  
  """Current confirmed balance"""
  balance: SignedAmount!
  
  """Available for immediate spending"""
  available: SignedAmount!
  
  """Pending incoming/outgoing"""
  pending: SignedAmount!
  
  """Source status"""
  status: CustodialSourceStatus!
}

"""
eCash balance information
"""
type ECashBalance {
  """Total eCash value"""
  total: SignedAmount!
  
  """Number of tokens in vault"""
  tokenCount: Int!
  
  """Breakdown by mint"""
  byMint: [MintBalance!]!
  
  """Oldest token timestamp"""
  oldestToken: Timestamp
  
  """Newest token timestamp"""
  newestToken: Timestamp
  
  """Tokens pending validation"""
  pendingTokens: Int!
}

"""
Balance at a specific mint
"""
type MintBalance {
  """Mint URL"""
  mintUrl: String!
  
  """Balance at this mint"""
  balance: SignedAmount!
  
  """Number of tokens"""
  tokenCount: Int!
}

"""
Available routing preview for a payment
"""
type RoutingPreview {
  """All possible routes"""
  routes: [PaymentRoute!]!
  
  """Recommended route based on preferences"""
  recommended: PaymentRoute!
  
  """Total estimated fees for recommended route"""
  estimatedFees: SignedAmount!
  
  """Estimated time in seconds"""
  estimatedTime: Int!
  
  """Warnings or limitations"""
  warnings: [String!]
}

"""
A possible payment route
"""
type PaymentRoute {
  """Unique route identifier"""
  id: String!
  
  """Route type"""
  type: RouteType!
  
  """Sources involved in this route"""
  sources: [RouteSource!]!
  
  """Total amount including fees"""
  totalAmount: SignedAmount!
  
  """Estimated fees"""
  fees: SignedAmount!
  
  """Estimated execution time in seconds"""
  estimatedTime: Int!
  
  """Route priority score (0-100)"""
  score: Int!
  
  """Required steps"""
  steps: [RouteStep!]!
}

"""
Source used in a route
"""
type RouteSource {
  """Source identifier"""
  id: String!
  
  """Source name"""
  name: String!
  
  """Amount from this source"""
  amount: SignedAmount!
  
  """Source type"""
  type: SourceType!
}

"""
Individual step in a route
"""
type RouteStep {
  """Step type"""
  type: StepType!
  
  """Step description"""
  description: String!
  
  """Estimated duration"""
  duration: Int!
}

"""
Mint information
"""
type Mint {
  """Mint URL"""
  url: String!
  
  """Mint public key"""
  pubkey: String!
  
  """Mint name"""
  name: String!
  
  """Supported operations"""
  capabilities: [String!]!
  
  """Is this the default mint"""
  isDefault: Boolean!
  
  """Mint status"""
  status: MintStatus!
  
  """Last successful health check"""
  lastHealthCheck: Timestamp!
}

"""
Cash wallet transaction
"""
type CashWalletTransaction implements Transaction {
  """Transaction ID"""
  id: ID!
  
  """Transaction status"""
  status: TransactionStatus!
  
  """Transaction direction"""
  direction: TxDirection!
  
  """Settlement amount"""
  settlementAmount: SignedAmount!
  
  """Settlement fee"""
  settlementFee: SignedAmount!
  
  """Display currency amount"""
  settlementDisplayAmount: SignedDisplayMajorAmount!
  
  """Creation timestamp"""
  createdAt: Timestamp!
  
  """Transaction memo"""
  memo: String
  
  """Route used for this transaction"""
  route: PaymentRoute
  
  """Sources used"""
  sources: [RouteSource!]!
  
  """Transaction type specific details"""
  details: CashWalletTransactionDetails!
}

"""
Transaction type specific details
"""
union CashWalletTransactionDetails = 
  | LightningTransactionDetails
  | CashuTransactionDetails
  | SwapTransactionDetails

type LightningTransactionDetails {
  """Lightning payment hash"""
  paymentHash: String!
  
  """Lightning invoice"""
  invoice: String!
  
  """Payment preimage (for completed payments)"""
  preimage: String
}

type CashuTransactionDetails {
  """Token string (for outgoing)"""
  token: String
  
  """Mint URL"""
  mintUrl: String!
  
  """Number of proofs"""
  proofCount: Int!
}

type SwapTransactionDetails {
  """Swap type"""
  swapType: SwapType!
  
  """From source"""
  fromSource: String!
  
  """To source"""
  toSource: String!
  
  """Swap fee"""
  swapFee: SignedAmount!
}

"""
Vault status information
"""
type VaultStatus {
  """Is vault initialized"""
  initialized: Boolean!
  
  """Is vault locked"""
  locked: Boolean!
  
  """Last backup timestamp"""
  lastBackup: Timestamp
  
  """Token statistics"""
  tokenStats: TokenStats!
}

type TokenStats {
  """Total token count"""
  totalTokens: Int!
  
  """Spent tokens awaiting cleanup"""
  spentTokens: Int!
  
  """Tokens by denomination"""
  byDenomination: [DenominationStat!]!
}

type DenominationStat {
  """Token amount"""
  amount: SignedAmount!
  
  """Count of tokens"""
  count: Int!
}

# Input Types

input CashWalletSendInput {
  """Amount to send"""
  amount: SignedAmount!
  
  """Destination (invoice, token request, address)"""
  destination: String!
  
  """Optional memo"""
  memo: String
  
  """Preferred routing strategy"""
  preferredRoute: RoutePreference
  
  """Maximum acceptable fee"""
  maxFee: SignedAmount
}

input CashWalletReceiveInput {
  """Payment data (invoice, token, etc)"""
  paymentData: String!
  
  """Expected amount (for validation)"""
  expectedAmount: SignedAmount
}

input CashWalletCreateInvoiceInput {
  """Invoice amount"""
  amount: SignedAmount!
  
  """Invoice memo"""
  memo: String
  
  """Expiry time in seconds"""
  expirySeconds: Int
}

input CashWalletTransactionFilter {
  """Filter by status"""
  status: TransactionStatus
  
  """Filter by direction"""
  direction: TxDirection
  
  """Filter by source type"""
  sourceType: SourceType
  
  """Date range start"""
  from: Timestamp
  
  """Date range end"""
  to: Timestamp
}

# Enums

enum RoutePreference {
  """Optimize for lowest fees"""
  CHEAPEST
  
  """Optimize for fastest execution"""
  FASTEST
  
  """Optimize for privacy (prefer eCash)"""
  PRIVATE
  
  """Automatic selection based on context"""
  AUTO
}

enum RouteType {
  """Single source payment"""
  SINGLE
  
  """Multiple sources combined"""
  SPLIT
  
  """Requires swap between sources"""
  SWAP
}

enum SourceType {
  """Custodial Lightning service"""
  CUSTODIAL_LIGHTNING
  
  """eCash tokens"""
  ECASH
  
  """On-chain funds"""
  ONCHAIN
}

enum StepType {
  """Direct payment"""
  DIRECT_PAYMENT
  
  """Token to Lightning swap"""
  TOKEN_SWAP
  
  """Split across sources"""
  SPLIT_PAYMENT
  
  """Consolidate tokens"""
  CONSOLIDATE
}

enum CustodialSourceStatus {
  """Source is online and operational"""
  ONLINE
  
  """Source is offline or unreachable"""
  OFFLINE
  
  """Source is degraded but functional"""
  DEGRADED
}

enum MintStatus {
  """Mint is operational"""
  ACTIVE
  
  """Mint is unreachable"""
  OFFLINE
  
  """Mint is not trusted"""
  UNTRUSTED
}

enum SwapType {
  """eCash to Lightning"""
  ECASH_TO_LIGHTNING
  
  """Lightning to eCash"""
  LIGHTNING_TO_ECASH
}

# Payloads

type CashWalletSendPayload {
  success: Boolean!
  transaction: CashWalletTransaction
  errors: [Error!]!
}

type CashWalletReceivePayload {
  success: Boolean!
  transaction: CashWalletTransaction
  errors: [Error!]!
}

type CashWalletInvoicePayload {
  success: Boolean!
  invoice: String
  expiresAt: Timestamp
  errors: [Error!]!
}

type CashWalletMintPayload {
  success: Boolean!
  mint: Mint
  errors: [Error!]!
}

type CashWalletMintsPayload {
  mints: [Mint!]!
  defaultMint: Mint
}

type CashWalletBackupPayload {
  success: Boolean!
  encryptedBackup: String
  backupId: String
  createdAt: Timestamp
  errors: [Error!]!
}

type CashWalletConsolidatePayload {
  success: Boolean!
  consolidatedCount: Int
  newTokenCount: Int
  savedFees: SignedAmount
  errors: [Error!]!
}

type CashWalletSyncPayload {
  success: Boolean!
  synced: [String!]!
  failed: [String!]!
  errors: [Error!]!
}

# Connection Types

type CashWalletTransactionConnection {
  edges: [CashWalletTransactionEdge!]!
  pageInfo: PageInfo!
}

type CashWalletTransactionEdge {
  cursor: String!
  node: CashWalletTransaction!
}
```

### Subscriptions

```graphql
extend type Subscription {
  """
  Subscribe to cash wallet balance updates
  """
  cashWalletBalanceUpdated: CashWalletBalance! @requiresAuth
  
  """
  Subscribe to cash wallet transactions
  """
  cashWalletTransactionUpdated(
    filter: CashWalletTransactionFilter
  ): CashWalletTransaction! @requiresAuth
  
  """
  Subscribe to routing status updates during payment
  """
  cashWalletRoutingStatus(
    transactionId: ID!
  ): RoutingStatusUpdate! @requiresAuth
}

type RoutingStatusUpdate {
  """Transaction ID"""
  transactionId: ID!
  
  """Current status"""
  status: RoutingStatus!
  
  """Current step"""
  currentStep: Int!
  
  """Total steps"""
  totalSteps: Int!
  
  """Step description"""
  stepDescription: String!
  
  """Estimated remaining time"""
  estimatedTimeRemaining: Int
  
  """Error if failed"""
  error: String
}

enum RoutingStatus {
  """Finding optimal route"""
  FINDING_ROUTE
  
  """Executing payment"""
  EXECUTING
  
  """Performing swap"""
  SWAPPING
  
  """Confirming payment"""
  CONFIRMING
  
  """Successfully completed"""
  COMPLETED
  
  """Failed to complete"""
  FAILED
}
```

## REST API Endpoints

For compatibility and specific use cases, REST endpoints are also provided:

### Balance Endpoints

```
GET /api/v1/cash-wallet/balance
Response: {
  total: { amount: 50000, currency: "USD" },
  custodial: [...],
  eCash: { total: { amount: 10000, currency: "USD" }, ... }
}

GET /api/v1/cash-wallet/balance/{source}
Response: {
  sourceId: "ibex",
  balance: { amount: 40000, currency: "USD" },
  ...
}
```

### Transaction Endpoints

```
POST /api/v1/cash-wallet/send
Body: {
  amount: { amount: 1000, currency: "USD" },
  destination: "lnbc1...",
  memo: "Payment for coffee"
}

POST /api/v1/cash-wallet/receive
Body: {
  paymentData: "cashu:token..."
}

GET /api/v1/cash-wallet/transactions
Query: ?limit=10&offset=0&status=completed
```

### Mint Management Endpoints

```
GET /api/v1/cash-wallet/mints
POST /api/v1/cash-wallet/mints
Body: { url: "https://mint.example.com" }

PUT /api/v1/cash-wallet/mints/{mintUrl}/default
DELETE /api/v1/cash-wallet/mints/{mintUrl}
```

### Vault Endpoints

```
POST /api/v1/cash-wallet/vault/backup
Response: {
  backupId: "abc123",
  encryptedData: "...",
  createdAt: "2024-01-01T00:00:00Z"
}

POST /api/v1/cash-wallet/vault/restore
Body: {
  backup: "encrypted_backup_string",
  password: "user_password"
}
```

## Error Codes

```typescript
enum CashWalletErrorCode {
  // Balance errors
  INSUFFICIENT_FUNDS = "INSUFFICIENT_FUNDS",
  BALANCE_SYNC_FAILED = "BALANCE_SYNC_FAILED",
  
  // Routing errors
  NO_ROUTE_FOUND = "NO_ROUTE_FOUND",
  ROUTE_EXECUTION_FAILED = "ROUTE_EXECUTION_FAILED",
  
  // Token errors
  INVALID_TOKEN = "INVALID_TOKEN",
  TOKEN_ALREADY_SPENT = "TOKEN_ALREADY_SPENT",
  TOKEN_EXPIRED = "TOKEN_EXPIRED",
  
  // Mint errors
  MINT_UNAVAILABLE = "MINT_UNAVAILABLE",
  MINT_NOT_TRUSTED = "MINT_NOT_TRUSTED",
  MINT_ALREADY_EXISTS = "MINT_ALREADY_EXISTS",
  
  // Vault errors
  VAULT_LOCKED = "VAULT_LOCKED",
  VAULT_CORRUPTED = "VAULT_CORRUPTED",
  BACKUP_INVALID = "BACKUP_INVALID",
  
  // Swap errors
  SWAP_FAILED = "SWAP_FAILED",
  SWAP_TIMEOUT = "SWAP_TIMEOUT",
  
  // General errors
  INVALID_DESTINATION = "INVALID_DESTINATION",
  OPERATION_TIMEOUT = "OPERATION_TIMEOUT",
  ADAPTER_ERROR = "ADAPTER_ERROR"
}
```

## WebSocket Events

For real-time updates, WebSocket connections support these events:

```typescript
// Client -> Server
interface ClientEvents {
  'subscribe:balance': { sources?: string[] }
  'subscribe:transactions': { filter?: TransactionFilter }
  'subscribe:routing': { transactionId: string }
  'unsubscribe': { topic: string }
}

// Server -> Client  
interface ServerEvents {
  'balance:updated': CashWalletBalance
  'transaction:new': CashWalletTransaction
  'transaction:updated': CashWalletTransaction
  'routing:status': RoutingStatusUpdate
  'error': { code: string, message: string }
}
```

## Rate Limiting

API endpoints are rate-limited to prevent abuse:

- Balance queries: 60 requests/minute
- Send operations: 30 requests/minute
- Receive operations: 60 requests/minute
- Mint management: 10 requests/minute
- Backup operations: 5 requests/hour

## Authentication

All endpoints require authentication via:
- Bearer token in Authorization header
- Session cookie (for web clients)
- API key (for programmatic access)

Example:
```
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```