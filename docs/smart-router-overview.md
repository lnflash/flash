# Smart Router Overview

## Executive Summary

The Smart Router is a comprehensive solution for implementing seamless eCash (Cashu) integration and multi-custodian routing in Flash's Cash Wallet. This feature provides users with a unified wallet experience while intelligently managing funds across multiple backend sources including custodial Lightning balances and offline-capable eCash tokens.

## Key Features

### 1. Unified Cash Wallet
- Single "Cash" wallet interface for users
- Combined balance from multiple sources (IBEX, eCash, future custodians)
- Transparent fund management behind the scenes

### 2. eCash Integration (Cashu Protocol)
- Offline-capable bearer asset support
- Default mint at `https://forge.flashapp.me`
- User-configurable mint list
- Secure local token storage

### 3. Intelligent Routing
- Automatic source selection for payments
- Multi-source payment capability
- Cashu-to-Lightning swap functionality
- Optimized fee routing

### 4. Security & Privacy
- Encrypted token storage
- Secure vault implementation
- Backup and restore capabilities
- Anti-replay protection

## Architecture Components

### Core System
- **CashWalletManager**: Central orchestration layer
- **Custodian Adapters**: Interface for Lightning custodians (IBEX, Strike, etc.)
- **Cashu Adapter**: eCash token management
- **Local Cash Vault**: Secure storage for Cashu tokens
- **Mint Registry**: Management of trusted mints

### Data Flow
```
User Interface
      ↓
CashWalletManager
      ↓
┌─────────────┬──────────────┬──────────────┐
│   IBEX      │    Cashu     │   Future     │
│  Adapter    │   Adapter    │  Custodians  │
└─────────────┴──────────────┴──────────────┘
      ↓               ↓              ↓
  Lightning      Local Vault    Other Services
```

## Benefits

### For Users
- Simplified experience with one "Cash" balance
- Offline payment capability with eCash
- Lower fees through intelligent routing
- Enhanced privacy options

### For Flash
- Reduced dependency on single custodian
- Scalability through multiple backend sources
- Foundation for future payment innovations
- Competitive advantage with eCash support

## Implementation Phases

### Phase 1: Foundation (Current)
- Core architecture setup
- IBEX adapter implementation
- Basic Cashu integration
- Local vault development

### Phase 2: Smart Routing
- Routing algorithm implementation
- Multi-source payments
- Cashu-to-Lightning swaps
- Balance optimization

### Phase 3: Enhanced Features
- Additional custodian adapters
- Advanced fee optimization
- Mint federation support
- Offline transfer capabilities

## Success Metrics
- Transaction success rate > 99%
- Routing optimization saves > 20% on fees
- User satisfaction score > 4.5/5
- Zero security incidents
- < 2 second transaction initiation time

## Related Documentation
- [Technical Architecture](./smart-router-architecture.md)
- [Implementation Plan](./smart-router-implementation-plan.md)
- [API Design](./smart-router-api-design.md)
- [Security Specification](./smart-router-security.md)
- [Testing Strategy](./smart-router-testing.md)