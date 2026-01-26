# Draft: Bridge.xyz Integration

## Requirements (confirmed)
- Each new Flash user becomes a Bridge customer when they complete KYC
- Users get a Bridge USD Virtual Account for fiat on-ramp (ACH/Wire)
- Virtual Account is connected to Flash (IBEX) USD Wallet
- Support US bank account on-ramp and off-ramp

## Architecture Understanding (from diagram)

### On-Ramp Flows
1. **US Bank → Bridge → User Wallet**
   - User US Bank Account → ACH/Wire → Bridge Virtual Account → On-Chain USDT → User USDT Wallet (IBEX)

2. **JM Bank → Flash → User Wallet** (existing)
   - User JM Bank → RTGS → Flash JM Bank Account → IBEX Flash USDT Wallet → On-Chain → User Wallet

### Off-Ramp Flows
1. **User Wallet → Bridge → US Bank**
   - User USDT Wallet → On-Chain → Bridge USDT Address → ACH/Wire → User US Bank

2. **User Wallet → Flash → JM Bank** (existing)
   - User USDT Wallet → Lightning Invoice → IBEX Flash USDT Wallet → Flash JM Bank → RTGS → User JM Bank

## Current Codebase Analysis

### Account Levels
- Level 0: Unverified (device account)
- Level 1: Basic verification
- Level 2: Pro
- Level 3: Merchant

### Account Creation Flow
- `src/app/accounts/create-account.ts`
  - `createAccountWithPhoneIdentifier()` - main entry point
  - `initializeCreatedAccount()` - creates wallets
  - Wallets created via `WalletsRepository().persistNew()`

### Wallet Creation
- `src/services/mongoose/wallets.ts`
  - `persistNew()` calls `Ibex.createAccount()` to create IBEX wallet
  - Each Flash wallet = 1 IBEX account
  - Currently only USD wallets (currencyId = 3)

### IBEX Integration
- `src/services/ibex/client.ts` - IBEX API client
- `src/services/ibex/webhook-server/` - handles IBEX events
- Deep integration throughout codebase

## Technical Decisions

### Bridge Customer Creation
- **Trigger**: When user reaches AccountLevel.One (KYC complete)
- **Location**: Hook into `updateAccountLevel()` or KYC completion flow

### Virtual Account Strategy
- **Lazy creation**: Only when user requests on-ramp capability
- **Reason**: Reduces Bridge costs, only for users who need it

### Destination for Bridge Deposits
- Bridge sends USDT to Flash operational wallet
- Flash then credits user via IBEX internal transfer
- Need to determine which chain Bridge should use

## Decisions Made
1. **Blockchain**: Tron (TRC-20) - Bridge supports USDT.trx
2. **Stablecoin**: USDT (not USDC/USDB)
3. **Bridge Customer Creation**: Lazy - on first on-ramp request
4. **Deposit Target**: Directly to user's IBEX wallet address (not intermediary)

## Remaining Open Questions
1. KYC data sharing - does Bridge need user info?
2. Fee structure - Bridge fees + Flash markup?
3. Does IBEX support receiving USDT on Tron?

## Research Findings

### Bridge.xyz API Capabilities
- Customer creation with KYC data
- Virtual accounts for fiat deposits (USD, EUR, MXN)
- Transfers for on-ramp/off-ramp
- External accounts for bank linking
- Webhooks for event notifications

### Supported Currencies/Chains
- Fiat: USD (ACH/Wire), EUR (SEPA), MXN (SPEI)
- Crypto: USDC, USDB on Ethereum, Polygon, Solana, Base

## Scope Boundaries

### INCLUDE
- Bridge service layer (`src/services/bridge/`)
- Account model extension (bridgeCustomerId)
- Bridge customer creation on KYC
- Virtual Account management
- External Account management
- Withdrawal/Transfer initiation
- Webhook server for Bridge events
- GraphQL API extensions
- Documentation

### EXCLUDE
- JM bank integration (existing, separate)
- Mobile app changes (separate repo)
- IBEX integration changes (already working)
- KYC flow changes (just hook into completion)
