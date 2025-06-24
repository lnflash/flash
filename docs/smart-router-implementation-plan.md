# Smart Router Implementation Plan

## Overview

This document outlines the phased implementation approach for the Smart Router feature in Flash. The implementation is divided into manageable phases with clear deliverables and success criteria.

### 📚 Implementation Approach Documents
- **[Methodical Implementation Guide](./smart-router-methodical-implementation.md)** - Detailed 40+ milestone breakdown with small PRs
- **[AI Implementation Guide](./smart-router-ai-implementation-guide.md)** - Step-by-step instructions for AI agents
- **[Security Specification](./smart-router-security.md)** - Security requirements and threat model
- **[Testing Strategy](./smart-router-testing.md)** - Comprehensive testing approach

**Important**: The methodical implementation guide supersedes the timeline in this document. We will follow a slower, more deliberate approach with 200-300 line PRs for thorough review.

## Implementation Phases

### Phase 1: Foundation (Weeks 1-3)

#### Goals
- Establish core architecture
- Implement basic adapter pattern
- Create local vault for Cashu tokens
- Set up development environment

#### Tasks

##### Week 1: Architecture Setup
- [ ] Create project structure and directories
- [ ] Define TypeScript interfaces and types
- [ ] Set up testing framework
- [ ] Create base adapter classes
- [ ] Implement error handling framework

##### Week 2: IBEX Adapter
- [ ] Implement IBEX adapter with existing integration
- [ ] Add balance queries
- [ ] Implement Lightning invoice creation
- [ ] Add payment execution
- [ ] Create adapter tests

##### Week 3: Local Vault
- [ ] Design encrypted storage schema
- [ ] Implement secure storage wrapper
- [ ] Create token management functions
- [ ] Add vault backup/restore
- [ ] Security audit preparation

#### Deliverables
- Core architecture in place
- Working IBEX adapter
- Secure local vault implementation
- Unit test coverage > 80%

### Phase 2: Cashu Integration (Weeks 4-6)

#### Goals
- Integrate Cashu protocol
- Implement mint management
- Create token operations
- Enable basic eCash functionality

#### Tasks

##### Week 4: Cashu Adapter
- [ ] Implement Cashu adapter interface
- [ ] Add token parsing and validation
- [ ] Create mint communication layer
- [ ] Implement token splitting/merging
- [ ] Add Cashu-specific error handling

##### Week 5: Mint Registry
- [ ] Create mint registry service
- [ ] Implement default mint configuration
- [ ] Add mint validation and health checks
- [ ] Create mint switching logic
- [ ] Implement mint persistence

##### Week 6: Token Operations
- [ ] Implement send token functionality
- [ ] Add receive token processing
- [ ] Create token selection algorithm
- [ ] Implement token refresh mechanism
- [ ] Add comprehensive logging

#### Deliverables
- Full Cashu integration
- Mint management system
- Token send/receive functionality
- Integration tests passing

### Phase 3: Smart Routing (Weeks 7-9)

#### Goals
- Implement routing engine
- Add multi-source payments
- Create swap functionality
- Optimize for fees and reliability

#### Tasks

##### Week 7: Routing Engine
- [ ] Design routing algorithm
- [ ] Implement route generation
- [ ] Add route scoring system
- [ ] Create fallback mechanisms
- [ ] Performance optimization

##### Week 8: Multi-Source Payments
- [ ] Implement split payment logic
- [ ] Add transaction coordination
- [ ] Create rollback mechanisms
- [ ] Implement partial payment handling
- [ ] Add comprehensive testing

##### Week 9: Cashu-to-Lightning Swaps
- [ ] Design swap flow
- [ ] Implement swap execution
- [ ] Add swap monitoring
- [ ] Create swap recovery logic
- [ ] Performance testing

#### Deliverables
- Working routing engine
- Multi-source payment capability
- Swap functionality
- Load testing completed

### Phase 4: Integration & Polish (Weeks 10-12)

#### Goals
- GraphQL API integration
- UI/UX implementation
- Performance optimization
- Security hardening

#### Tasks

##### Week 10: API Integration
- [ ] Create GraphQL schema updates
- [ ] Implement resolver functions
- [ ] Add subscription support
- [ ] Create API documentation
- [ ] Integration with existing endpoints

##### Week 11: Frontend Integration
- [ ] Update wallet UI components
- [ ] Add settings management
- [ ] Implement transaction history
- [ ] Create balance display
- [ ] Add error handling UI

##### Week 12: Final Polish
- [ ] Performance optimization
- [ ] Security audit fixes
- [ ] Documentation completion
- [ ] Beta testing preparation
- [ ] Deployment planning

#### Deliverables
- Full API integration
- Updated mobile app
- Complete documentation
- Production-ready code

## Technical Implementation Details

### Directory Structure

```
src/
├── app/
│   └── cash-wallet/
│       ├── index.ts
│       ├── cash-wallet-manager.ts
│       ├── routing-engine.ts
│       └── sync-manager.ts
├── domain/
│   └── cash-wallet/
│       ├── index.types.d.ts
│       ├── errors.ts
│       ├── routing-strategies.ts
│       └── validators.ts
├── services/
│   └── cash-wallet/
│       ├── adapters/
│       │   ├── base-adapter.ts
│       │   ├── ibex-adapter.ts
│       │   ├── cashu-adapter.ts
│       │   └── index.ts
│       ├── vault/
│       │   ├── local-cash-vault.ts
│       │   ├── encryption.ts
│       │   └── token-selector.ts
│       ├── mints/
│       │   ├── mint-registry.ts
│       │   ├── mint-client.ts
│       │   └── mint-validator.ts
│       └── index.ts
└── graphql/
    └── public/
        └── types/
            └── object/
                └── cash-wallet.ts
```

### Database Schema Updates

```typescript
// New collections/tables needed

// Mint Registry Collection
interface MintRecord {
  _id: ObjectId
  url: string
  name: string
  pubkey: string
  capabilities: string[]
  isDefault: boolean
  isActive: boolean
  lastHealthCheck: Date
  createdAt: Date
  updatedAt: Date
}

// Transaction Routes Collection (for analytics)
interface RouteRecord {
  _id: ObjectId
  transactionId: string
  amount: number
  route: PaymentRoute
  result: 'success' | 'failed'
  executionTime: number
  fees: number
  timestamp: Date
}

// Vault Backup Collection
interface VaultBackup {
  _id: ObjectId
  accountId: string
  encryptedData: string
  version: number
  createdAt: Date
}
```

### GraphQL Schema Updates

```graphql
extend type Query {
  # Cash wallet balance with breakdown
  cashWalletBalance: CashWalletBalance!
  
  # List configured mints
  cashWalletMints: [Mint!]!
  
  # Get routing preview for amount
  cashWalletRoutingPreview(amount: Int!, recipient: String!): RoutingPreview!
}

extend type Mutation {
  # Send from cash wallet (auto-routing)
  cashWalletSend(input: CashWalletSendInput!): CashWalletTransaction!
  
  # Receive into cash wallet
  cashWalletReceive(input: CashWalletReceiveInput!): CashWalletTransaction!
  
  # Mint management
  cashWalletAddMint(url: String!): Mint!
  cashWalletSetDefaultMint(url: String!): Mint!
  cashWalletRemoveMint(url: String!): Success!
  
  # Vault operations
  cashWalletBackup: CashWalletBackup!
  cashWalletRestore(backup: String!): Success!
}

type CashWalletBalance {
  total: SignedAmount!
  custodial: [CustodialBalance!]!
  eCash: ECashBalance!
  lastSync: Timestamp!
}

type CustodialBalance {
  source: String!
  balance: SignedAmount!
  available: SignedAmount!
  pending: SignedAmount!
}

type ECashBalance {
  total: SignedAmount!
  tokenCount: Int!
  oldestToken: Timestamp
  newestToken: Timestamp
}

type RoutingPreview {
  routes: [PaymentRoute!]!
  recommended: PaymentRoute!
  estimatedFees: SignedAmount!
  estimatedTime: Int!
}

input CashWalletSendInput {
  amount: SignedAmount!
  destination: String! # Lightning invoice, Cashu token, or on-chain
  memo: String
  preferredRoute: RoutePreference
}

enum RoutePreference {
  CHEAPEST
  FASTEST
  PRIVATE
  AUTO
}
```

### Integration Points

#### 1. Existing Services Integration

```typescript
// Integrate with existing Flash services

class CashWalletIntegration {
  constructor(
    private ledgerService: ILedgerService,
    private notificationService: INotificationService,
    private analyticsService: IAnalyticsService
  ) {}
  
  async recordTransaction(tx: CashWalletTransaction) {
    // Record in ledger
    await this.ledgerService.recordCashWalletTx(tx)
    
    // Send notification
    await this.notificationService.notifyTransaction(tx)
    
    // Track analytics
    await this.analyticsService.track('cash_wallet_transaction', {
      type: tx.type,
      amount: tx.amount,
      route: tx.route.type
    })
  }
}
```

#### 2. Session Context Updates

```typescript
// Add to GraphQL context
interface CashWalletContext {
  cashWalletManager: CashWalletManager
  mintRegistry: MintRegistry
  vault: LocalCashVault
}

// Extend existing context
interface GraphQLContextForUser {
  // ... existing fields
  cashWallet: CashWalletContext
}
```

### Testing Strategy

#### Unit Tests
```typescript
// Example test structure
describe('CashWalletManager', () => {
  describe('sendCash', () => {
    it('should route through single custodian when sufficient balance')
    it('should use multi-source when needed and supported')
    it('should perform swap when only eCash available')
    it('should fail gracefully when insufficient total balance')
  })
})
```

#### Integration Tests
- Test actual mint communication
- Verify encryption/decryption
- Test routing decisions
- Validate swap flows

#### E2E Tests
- Complete user flows
- Multi-device scenarios
- Offline/online transitions
- Recovery scenarios

### Security Implementation

#### Encryption Strategy
```typescript
class VaultEncryption {
  private async deriveKey(password: string, salt: Buffer): Promise<CryptoKey> {
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(password),
      'PBKDF2',
      false,
      ['deriveKey']
    )
    
    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt,
        iterations: 100000,
        hash: 'SHA-256'
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    )
  }
}
```

#### Audit Logging
```typescript
class CashWalletAuditLogger {
  async log(event: AuditEvent) {
    await this.auditService.record({
      timestamp: new Date(),
      accountId: event.accountId,
      action: event.action,
      details: event.details,
      result: event.result,
      metadata: {
        route: event.route,
        adapters: event.adaptersUsed,
        amount: event.amount
      }
    })
  }
}
```

## Rollout Strategy

### Beta Testing Plan
1. **Internal Testing** (Week 13)
   - Flash team testing
   - Automated test scenarios
   - Performance benchmarking

2. **Limited Beta** (Week 14-15)
   - 100 selected users
   - Gradual feature enablement
   - Feedback collection

3. **Public Beta** (Week 16-17)
   - 10% of user base
   - A/B testing
   - Performance monitoring

4. **Full Release** (Week 18)
   - 100% rollout
   - Marketing campaign
   - Support preparation

### Feature Flags
```typescript
enum CashWalletFeatureFlags {
  CASH_WALLET_ENABLED = 'cash_wallet_enabled',
  ECASH_ENABLED = 'ecash_enabled',
  MULTI_SOURCE_ENABLED = 'multi_source_enabled',
  SWAP_ENABLED = 'swap_enabled',
  CUSTOM_MINTS_ENABLED = 'custom_mints_enabled'
}
```

### Monitoring & Metrics
- Transaction success rate
- Route selection distribution
- Swap success rate
- Vault operation performance
- Error rates by type
- User adoption metrics

## Risk Mitigation

### Technical Risks
1. **Mint Unavailability**
   - Mitigation: Multiple mint support, fallback options
   
2. **Token Loss**
   - Mitigation: Automatic backups, recovery mechanisms
   
3. **Performance Issues**
   - Mitigation: Caching, optimization, load testing

### Business Risks
1. **User Confusion**
   - Mitigation: Clear UI/UX, educational content
   
2. **Regulatory Concerns**
   - Mitigation: Legal review, compliance checks
   
3. **Custodian Issues**
   - Mitigation: Multi-custodian support, monitoring

## Success Criteria

### Technical Metrics
- 99.9% uptime
- < 2s transaction initiation
- < 5s end-to-end transaction
- 0 security incidents

### Business Metrics
- 50% user adoption in 3 months
- 20% reduction in transaction fees
- 4.5+ app store rating maintained
- 30% reduction in support tickets

### User Experience Metrics
- 90% successful transaction rate
- 80% user satisfaction score
- 70% feature usage rate
- 60% retention after first use