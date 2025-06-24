# Smart Router Testing Strategy

## Overview

This document outlines the comprehensive testing approach for the Smart Router feature, covering unit tests, integration tests, end-to-end tests, and performance testing.

## Testing Principles

1. **Test Coverage**: Minimum 90% code coverage for critical paths
2. **Test Isolation**: Each test should be independent and repeatable
3. **Test Performance**: Tests should run quickly (< 5 minutes for unit tests)
4. **Test Documentation**: Clear test names and descriptions
5. **Test Data**: Realistic test scenarios with edge cases

## Test Categories

### 1. Unit Tests

#### Core Components

##### CashWalletManager Tests
```typescript
describe('CashWalletManager', () => {
  let manager: CashWalletManager
  let mockAdapters: Map<string, MockAdapter>
  
  beforeEach(() => {
    mockAdapters = createMockAdapters()
    manager = new CashWalletManager({ adapters: mockAdapters })
  })
  
  describe('getBalance', () => {
    it('should aggregate balances from all sources', async () => {
      // Arrange
      mockAdapters.get('ibex').setBalance(50000)
      mockAdapters.get('cashu').setBalance(10000)
      
      // Act
      const balance = await manager.getBalance()
      
      // Assert
      expect(balance.total).toBe(60000)
      expect(balance.custodial[0].balance).toBe(50000)
      expect(balance.eCash.total).toBe(10000)
    })
    
    it('should handle adapter failures gracefully', async () => {
      // Arrange
      mockAdapters.get('ibex').throwError('Network error')
      
      // Act
      const balance = await manager.getBalance()
      
      // Assert
      expect(balance.total).toBe(10000) // Only cashu balance
      expect(balance.custodial[0].status).toBe('OFFLINE')
    })
  })
  
  describe('sendCash', () => {
    it('should use single source when sufficient balance', async () => {
      // Test implementation
    })
    
    it('should split payment when recipient supports it', async () => {
      // Test implementation
    })
    
    it('should perform swap when only eCash available', async () => {
      // Test implementation
    })
    
    it('should fail when insufficient total balance', async () => {
      // Test implementation
    })
  })
})
```

##### Routing Engine Tests
```typescript
describe('RoutingEngine', () => {
  let engine: RoutingEngine
  
  describe('findOptimalRoute', () => {
    it('should prefer single source routes', async () => {
      const routes = await engine.findOptimalRoute(1000, recipient, adapters)
      expect(routes[0].type).toBe('single')
    })
    
    it('should calculate fees correctly', async () => {
      const route = await engine.findOptimalRoute(10000, recipient, adapters)
      expect(route.fees).toBeLessThan(100) // Less than 1%
    })
    
    it('should respect route preferences', async () => {
      const route = await engine.findOptimalRoute(
        5000, 
        recipient, 
        adapters,
        RoutePreference.PRIVATE
      )
      expect(route.sources[0].type).toBe('ECASH')
    })
  })
})
```

##### Cashu Adapter Tests
```typescript
describe('CashuAdapter', () => {
  let adapter: CashuAdapter
  let mockVault: MockVault
  let mockMint: MockMint
  
  describe('sendToken', () => {
    it('should select optimal tokens for amount', async () => {
      // Arrange
      mockVault.addTokens([
        { amount: 1000 },
        { amount: 500 },
        { amount: 100 },
        { amount: 100 }
      ])
      
      // Act
      const token = await adapter.sendToken(600)
      
      // Assert
      expect(token.amount).toBe(600)
      expect(mockVault.getSpentTokens()).toHaveLength(2) // Used 500 + 100
    })
    
    it('should handle token splitting at mint', async () => {
      // Test implementation
    })
  })
  
  describe('receiveToken', () => {
    it('should validate token signatures', async () => {
      const invalidToken = createTokenWithInvalidSignature()
      await expect(adapter.receiveToken(invalidToken))
        .rejects.toThrow('Invalid token signature')
    })
    
    it('should detect already spent tokens', async () => {
      const spentToken = createSpentToken()
      await expect(adapter.receiveToken(spentToken))
        .rejects.toThrow('Token already spent')
    })
  })
})
```

##### Vault Security Tests
```typescript
describe('LocalCashVault', () => {
  let vault: LocalCashVault
  
  describe('encryption', () => {
    it('should encrypt tokens at rest', async () => {
      const token = createTestToken()
      await vault.storeToken(token)
      
      const rawData = await getRawStorageData()
      expect(rawData).not.toContain(token.secret)
      expect(rawData).toMatch(/^[A-Za-z0-9+/=]+$/) // Base64 encrypted
    })
    
    it('should require authentication to access', async () => {
      await expect(vault.getAllTokens())
        .rejects.toThrow('Authentication required')
    })
  })
  
  describe('token selection', () => {
    it('should minimize token count for payments', async () => {
      // Add various denominations
      await vault.addTokens(createTokenSet())
      
      const selected = await vault.selectTokensForAmount(1500)
      expect(selected).toHaveLength(2) // Optimal selection
    })
  })
})
```

### 2. Integration Tests

#### Adapter Integration Tests
```typescript
describe('IBEX Adapter Integration', () => {
  let adapter: IBEXAdapter
  let testAccount: TestAccount
  
  beforeAll(async () => {
    testAccount = await createTestAccount()
    adapter = new IBEXAdapter(testAccount.credentials)
  })
  
  it('should fetch real balance', async () => {
    const balance = await adapter.getBalance()
    expect(balance).toBeGreaterThanOrEqual(0)
    expect(balance).toBeLessThan(1000000) // Sanity check
  })
  
  it('should create and pay invoice', async () => {
    // Create invoice
    const invoice = await adapter.createInvoice(100, 'Test payment')
    expect(invoice).toMatch(/^lnbc/)
    
    // Pay from another adapter
    const result = await otherAdapter.payInvoice(invoice)
    expect(result.success).toBe(true)
  })
})
```

#### Mint Communication Tests
```typescript
describe('Mint Integration', () => {
  const MINT_URL = 'https://forge.flashapp.me'
  let mint: Mint
  
  beforeAll(async () => {
    mint = await Mint.connect(MINT_URL)
  })
  
  it('should fetch mint info', async () => {
    const info = await mint.getInfo()
    expect(info.name).toBeDefined()
    expect(info.pubkey).toBeDefined()
    expect(info.version).toBeDefined()
  })
  
  it('should perform token operations', async () => {
    // Mint tokens
    const tokens = await mint.mint(1000, 'test_invoice')
    expect(tokens.proofs).toHaveLength(4) // 1000 = 512 + 256 + 128 + 64 + 32 + 8
    
    // Split tokens
    const splitTokens = await mint.split(tokens, 300)
    expect(splitTokens.amount).toBe(300)
    
    // Melt tokens
    const invoice = 'lnbc300...'
    await mint.melt(splitTokens, invoice)
  })
})
```

### 3. End-to-End Tests

#### Complete User Flows
```typescript
describe('E2E: Cash Wallet User Flows', () => {
  let app: TestApp
  let user: TestUser
  
  beforeEach(async () => {
    app = await TestApp.launch()
    user = await app.createUser()
    await user.fundWallet(10000) // Fund with sats
  })
  
  describe('Send Flow', () => {
    it('should complete Lightning payment from mixed sources', async () => {
      // Arrange
      await user.receiveEcash(5000)
      await user.fundCustodial(3000)
      
      // Act
      const invoice = await createExternalInvoice(7000)
      await user.navigateTo('Send')
      await user.pasteInvoice(invoice)
      await user.confirmPayment()
      
      // Assert
      await user.waitForSuccess()
      const balance = await user.getBalance()
      expect(balance.total).toBe(1000) // 8000 - 7000
      
      // Verify route used
      const lastTx = await user.getLastTransaction()
      expect(lastTx.route.type).toBe('split')
      expect(lastTx.route.sources).toHaveLength(2)
    })
  })
  
  describe('Receive Flow', () => {
    it('should receive and validate Cashu tokens', async () => {
      // Arrange
      const token = await createCashuToken(1000)
      
      // Act
      await user.navigateTo('Receive')
      await user.selectReceiveMethod('Paste')
      await user.pasteToken(token)
      
      // Assert
      await user.waitForSuccess()
      const balance = await user.getBalance()
      expect(balance.eCash.total).toBe(1000)
    })
  })
  
  describe('Mint Management', () => {
    it('should add custom mint and use it', async () => {
      // Act
      await user.navigateTo('Settings')
      await user.selectOption('Mints')
      await user.addMint('https://custom.mint.example')
      await user.setDefaultMint('https://custom.mint.example')
      
      // Verify
      const mints = await user.getMints()
      expect(mints.default.url).toBe('https://custom.mint.example')
    })
  })
})
```

### 4. Performance Tests

#### Load Testing
```typescript
describe('Performance: Cash Wallet Load Tests', () => {
  it('should handle 100 concurrent balance requests', async () => {
    const startTime = Date.now()
    
    const requests = Array(100).fill(0).map(() => 
      manager.getBalance()
    )
    
    await Promise.all(requests)
    
    const duration = Date.now() - startTime
    expect(duration).toBeLessThan(1000) // Under 1 second
  })
  
  it('should process 50 payments per second', async () => {
    const payments = generateTestPayments(50)
    const startTime = Date.now()
    
    const results = await Promise.all(
      payments.map(p => manager.sendCash(p.amount, p.recipient))
    )
    
    const duration = Date.now() - startTime
    expect(duration).toBeLessThan(1000)
    expect(results.filter(r => r.success).length).toBeGreaterThan(45)
  })
})
```

#### Stress Testing
```typescript
describe('Stress: Vault Operations', () => {
  it('should handle large token counts', async () => {
    // Add 10,000 tokens
    const tokens = generateTokens(10000)
    await vault.addTokens(tokens)
    
    // Test operations
    const balance = await vault.getBalance()
    expect(balance).toBe(tokens.reduce((sum, t) => sum + t.amount, 0))
    
    // Selection should still be fast
    const startTime = Date.now()
    await vault.selectTokensForAmount(5000)
    expect(Date.now() - startTime).toBeLessThan(100)
  })
})
```

### 5. Security Tests

#### Penetration Testing Scenarios
```typescript
describe('Security: Attack Scenarios', () => {
  describe('Token Replay Attack', () => {
    it('should prevent double spending', async () => {
      const token = await createValidToken(1000)
      
      // First spend should succeed
      await wallet.receiveToken(token)
      
      // Second spend should fail
      await expect(wallet.receiveToken(token))
        .rejects.toThrow('Token already spent')
    })
  })
  
  describe('Mint Impersonation', () => {
    it('should reject invalid mint certificates', async () => {
      const fakeMint = 'https://evil.mint.example'
      
      await expect(mintRegistry.addMint(fakeMint))
        .rejects.toThrow('Invalid mint certificate')
    })
  })
  
  describe('Vault Tampering', () => {
    it('should detect corrupted vault data', async () => {
      // Corrupt vault file
      await corruptVaultFile()
      
      // Should fail safely
      await expect(vault.getAllTokens())
        .rejects.toThrow('Vault integrity check failed')
    })
  })
})
```

### 6. Regression Tests

#### Historical Bug Prevention
```typescript
describe('Regression: Fixed Issues', () => {
  it('should not lose tokens during failed swap', async () => {
    // Setup scenario that previously caused token loss
    const tokens = await vault.getTokens(5000)
    
    // Simulate swap failure
    mockMint.failNextMelt()
    
    // Attempt swap
    await expect(
      cashWallet.swapToLightning(tokens, failingInvoice)
    ).rejects.toThrow()
    
    // Verify tokens returned to vault
    const balance = await vault.getBalance()
    expect(balance).toBe(5000)
  })
})
```

## Test Data Management

### Test Fixtures
```typescript
// test/fixtures/tokens.ts
export const validTokens = {
  small: createToken(100),
  medium: createToken(1000),
  large: createToken(10000),
  spent: createSpentToken(),
  expired: createExpiredToken(),
  invalid: createInvalidToken()
}

// test/fixtures/mints.ts
export const testMints = {
  default: 'https://forge.flashapp.me',
  secondary: 'https://test.mint.example',
  offline: 'https://offline.mint.example',
  malicious: 'https://evil.mint.example'
}
```

### Mock Implementations
```typescript
class MockAdapter implements PaymentAdapter {
  private balance: number = 0
  private shouldFail: boolean = false
  
  setBalance(amount: number) {
    this.balance = amount
  }
  
  failNext() {
    this.shouldFail = true
  }
  
  async getBalance(): Promise<number> {
    if (this.shouldFail) {
      this.shouldFail = false
      throw new Error('Mock failure')
    }
    return this.balance
  }
}
```

## Test Execution Strategy

### Continuous Integration
```yaml
# .github/workflows/test.yml
name: Smart Router Tests

on: [push, pull_request]

jobs:
  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - name: Run unit tests
        run: npm run test:unit
      - name: Upload coverage
        uses: codecov/codecov-action@v1
  
  integration-tests:
    runs-on: ubuntu-latest
    services:
      mint:
        image: cashu/nutshell:latest
        ports:
          - 3338:3338
    steps:
      - name: Run integration tests
        run: npm run test:integration
  
  e2e-tests:
    runs-on: macos-latest # For iOS simulator
    steps:
      - name: Run E2E tests
        run: npm run test:e2e
```

### Test Environments
1. **Local Development**: Mock services
2. **CI Environment**: Dockerized services
3. **Staging**: Real test mint, test Lightning nodes
4. **Pre-Production**: Production-like environment

## Test Metrics

### Coverage Goals
- Unit Tests: 95% coverage
- Integration Tests: 80% coverage
- E2E Tests: Critical paths covered
- Security Tests: All attack vectors covered

### Performance Benchmarks
- Unit test suite: < 30 seconds
- Integration tests: < 2 minutes
- E2E tests: < 10 minutes
- Full test suite: < 15 minutes

## Test Reporting

### Test Results Dashboard
- Pass/fail rates by component
- Coverage trends
- Performance metrics
- Flaky test tracking

### Failure Analysis
- Automatic failure categorization
- Root cause analysis
- Impact assessment
- Fix prioritization