# Smart Router Technical Architecture

## System Architecture

### High-Level Design

```
┌─────────────────────────────────────────────────────────────┐
│                      User Interface Layer                    │
│                    (Mobile App / Web App)                    │
└─────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                    CashWalletManager                         │
│  - Balance aggregation                                       │
│  - Transaction orchestration                                 │
│  - Routing decisions                                         │
└─────────────────────────────────────────────────────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          ▼                    ▼                    ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│  IBEX Adapter    │ │  Cashu Adapter   │ │ Future Adapters  │
│                  │ │                  │ │ (Strike, etc.)   │
└──────────────────┘ └──────────────────┘ └──────────────────┘
          │                    │                    │
          ▼                    ▼                    ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│  IBEX Service    │ │  Local Vault     │ │ External APIs    │
│  (Lightning)     │ │  Mint Registry   │ │                  │
└──────────────────┘ └──────────────────┘ └──────────────────┘
```

## Core Components

### 1. CashWalletManager

Central orchestration layer responsible for:
- Aggregating balances from all sources
- Making routing decisions
- Executing transactions
- Managing state synchronization

```typescript
class CashWalletManager {
  private adapters: Map<string, PaymentAdapter>
  private routingEngine: RoutingEngine
  private vault: LocalCashVault
  
  constructor(config: WalletConfig) {
    this.adapters = new Map()
    this.routingEngine = new RoutingEngine(config.routingStrategy)
    this.vault = new LocalCashVault(config.storage)
  }
  
  async getBalance(): Promise<CashBalance> {
    const balances = await Promise.all(
      Array.from(this.adapters.values()).map(a => a.getBalance())
    )
    return this.aggregateBalances(balances)
  }
  
  async sendCash(amount: number, recipient: Recipient): Promise<SendResult> {
    const route = await this.routingEngine.findOptimalRoute(amount, recipient)
    return this.executeRoute(route)
  }
}
```

### 2. Payment Adapter Interface

Common interface for all payment sources:

```typescript
interface PaymentAdapter {
  id: string
  type: AdapterType
  priority: number
  
  // Balance operations
  getBalance(): Promise<Balance>
  sync(): Promise<void>
  
  // Payment operations
  canPay(amount: number, recipient: Recipient): Promise<boolean>
  createInvoice(amount: number, memo?: string): Promise<Invoice>
  payInvoice(invoice: string, amount?: number): Promise<PaymentResult>
  
  // Metadata
  getFees(amount: number): Promise<FeeEstimate>
  getCapabilities(): AdapterCapabilities
}

interface AdapterCapabilities {
  supportsOffline: boolean
  supportsLightning: boolean
  supportsCashu: boolean
  maxSendAmount?: number
  minSendAmount?: number
}
```

### 3. Routing Engine

Intelligent routing logic for optimal payment paths:

```typescript
class RoutingEngine {
  constructor(private strategy: RoutingStrategy) {}
  
  async findOptimalRoute(
    amount: number,
    recipient: Recipient,
    adapters: PaymentAdapter[]
  ): Promise<PaymentRoute> {
    const routes = await this.generatePossibleRoutes(amount, recipient, adapters)
    return this.selectOptimalRoute(routes)
  }
  
  private async generatePossibleRoutes(
    amount: number,
    recipient: Recipient,
    adapters: PaymentAdapter[]
  ): Promise<PaymentRoute[]> {
    const routes: PaymentRoute[] = []
    
    // Single-source routes
    for (const adapter of adapters) {
      if (await adapter.canPay(amount, recipient)) {
        routes.push({
          type: 'single',
          adapters: [adapter],
          amount,
          estimatedFee: await adapter.getFees(amount)
        })
      }
    }
    
    // Multi-source routes (if recipient supports)
    if (recipient.supportsSplitPayments) {
      routes.push(...await this.generateSplitRoutes(amount, recipient, adapters))
    }
    
    // Swap routes (Cashu → Lightning)
    routes.push(...await this.generateSwapRoutes(amount, recipient, adapters))
    
    return routes
  }
}
```

### 4. Cashu Adapter

Manages eCash tokens and mint interactions:

```typescript
class CashuAdapter implements PaymentAdapter {
  private vault: LocalCashVault
  private mintRegistry: MintRegistry
  private defaultMint: Mint
  
  async sendToken(amount: number): Promise<CashuToken> {
    const tokens = await this.vault.selectTokensForAmount(amount)
    const newToken = await this.defaultMint.split(tokens, amount)
    await this.vault.markTokensAsSpent(tokens)
    return newToken
  }
  
  async receiveToken(tokenString: string): Promise<void> {
    const token = CashuToken.parse(tokenString)
    const isValid = await this.validateToken(token)
    if (!isValid) throw new Error('Invalid token')
    
    await this.vault.storeToken(token)
  }
  
  async redeemToLightning(invoice: string): Promise<void> {
    const amount = LightningInvoice.decode(invoice).amount
    const tokens = await this.vault.selectTokensForAmount(amount)
    await this.defaultMint.melt(tokens, invoice)
    await this.vault.markTokensAsSpent(tokens)
  }
}
```

### 5. Local Cash Vault

Secure storage for Cashu tokens:

```typescript
class LocalCashVault {
  private storage: SecureStorage
  private encryptionKey: CryptoKey
  
  async storeToken(token: CashuToken): Promise<void> {
    const encrypted = await this.encrypt(token)
    await this.storage.save(`token:${token.id}`, encrypted)
    await this.updateIndex(token)
  }
  
  async selectTokensForAmount(amount: number): Promise<CashuToken[]> {
    const tokens = await this.getUnspentTokens()
    return this.coinSelection(tokens, amount)
  }
  
  private async encrypt(data: any): Promise<EncryptedData> {
    // Use platform-specific secure encryption
    // iOS: Keychain with Secure Enclave
    // Android: Android Keystore
    return platformEncrypt(data, this.encryptionKey)
  }
}
```

### 6. Mint Registry

Manages trusted mints and their metadata:

```typescript
class MintRegistry {
  private mints: Map<string, Mint>
  private defaultMintUrl: string = 'https://forge.flashapp.me'
  
  async addMint(url: string): Promise<void> {
    const mintInfo = await this.fetchMintInfo(url)
    await this.validateMint(mintInfo)
    
    const mint = new Mint(url, mintInfo)
    this.mints.set(url, mint)
  }
  
  async setDefaultMint(url: string): Promise<void> {
    if (!this.mints.has(url)) {
      throw new Error('Mint not registered')
    }
    this.defaultMintUrl = url
  }
  
  private async validateMint(info: MintInfo): Promise<void> {
    // Verify SSL certificate
    // Check mint capabilities
    // Validate supported tokens
  }
}
```

## Data Models

### Core Types

```typescript
interface CashBalance {
  total: number
  breakdown: {
    custodial: CustodialBalance[]
    eCash: ECashBalance
  }
  lastSync: Date
}

interface CustodialBalance {
  adapterId: string
  name: string
  balance: number
  available: number
  pending: number
}

interface ECashBalance {
  total: number
  byMint: Map<string, number>
  tokenCount: number
}

interface PaymentRoute {
  type: 'single' | 'split' | 'swap'
  adapters: PaymentAdapter[]
  amount: number
  estimatedFee: number
  estimatedTime: number
  requiredSteps: PaymentStep[]
}

interface PaymentStep {
  type: 'direct' | 'swap' | 'split'
  from: string
  to: string
  amount: number
  fee: number
}
```

### Cashu Token Structure

```typescript
interface CashuToken {
  id: string
  amount: number
  C: string // Token commitment
  secret: string
  mint: string
  proofs: Proof[]
}

interface Proof {
  amount: number
  id: string
  secret: string
  C: string
  witness?: string
}
```

## State Management

### Transaction State Machine

```
┌─────────┐     ┌──────────┐     ┌───────────┐     ┌──────────┐
│ Pending │────▶│ Routing  │────▶│ Executing │────▶│ Complete │
└─────────┘     └──────────┘     └───────────┘     └──────────┘
     │                │                  │                 │
     └────────────────┴──────────────────┴─────────────────┘
                              │
                              ▼
                         ┌─────────┐
                         │ Failed  │
                         └─────────┘
```

### Sync Strategy

```typescript
class SyncManager {
  private syncInterval = 30_000 // 30 seconds
  private lastSync: Map<string, Date>
  
  async syncAll(): Promise<void> {
    await Promise.allSettled([
      this.syncCustodialBalances(),
      this.syncCashuTokens(),
      this.syncPendingTransactions()
    ])
  }
  
  private async syncCustodialBalances(): Promise<void> {
    for (const [id, adapter] of this.adapters) {
      if (this.shouldSync(id)) {
        await adapter.sync()
        this.lastSync.set(id, new Date())
      }
    }
  }
}
```

## Error Handling

### Error Types

```typescript
enum SmartRouterError {
  INSUFFICIENT_FUNDS = 'INSUFFICIENT_FUNDS',
  NO_ROUTE_FOUND = 'NO_ROUTE_FOUND',
  INVALID_TOKEN = 'INVALID_TOKEN',
  MINT_UNAVAILABLE = 'MINT_UNAVAILABLE',
  ADAPTER_ERROR = 'ADAPTER_ERROR',
  SWAP_FAILED = 'SWAP_FAILED'
}

class SmartRouterException extends Error {
  constructor(
    public code: SmartRouterError,
    public details: any,
    message: string
  ) {
    super(message)
  }
}
```

### Recovery Strategies

1. **Automatic Retry**: For transient network errors
2. **Fallback Routes**: Try alternative payment paths
3. **Partial Refunds**: Return unused tokens to vault
4. **Manual Intervention**: Notify user for critical errors

## Performance Considerations

### Optimization Strategies

1. **Parallel Balance Queries**: Fetch all balances concurrently
2. **Route Caching**: Cache successful routes for similar amounts
3. **Token Consolidation**: Periodically merge small tokens
4. **Lazy Loading**: Load adapters on-demand
5. **Background Sync**: Update balances in background

### Benchmarks

- Balance query: < 100ms (cached), < 1s (fresh)
- Route calculation: < 200ms
- Payment initiation: < 500ms
- Token validation: < 50ms
- Vault operations: < 100ms