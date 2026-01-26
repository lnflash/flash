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
1. **Blockchain**: Tron (TRC-20) - Bridge supports USDT.trx with enhanced support
2. **Stablecoin**: USDT (TRC-20) directly to IBEX wallet
3. **Bridge Customer Creation**: Lazy - on first on-ramp request
4. **Deposit Target**: Directly to user's IBEX wallet Tron address
5. **KYC**: Bridge uses Persona - can use KYC Links API (hosted flow)
6. **Fee Structure**: Bridge fees + 0.5% Flash markup

## IBEX Crypto API (Confirmed)
- `GET /crypto/receive-infos/options` - Get available crypto options
- `POST /crypto/receive-infos` - Create receive address (Tron USDT)
- `POST /crypto/send-infos` - Create send destination
- `POST /crypto/send` - Send crypto (for off-ramp)

## Bridge KYC Requirements (Individual)
**Required Fields:**
- first_name, last_name
- email
- residential_address (street_line_1, city, subdivision, postal_code, country)
- birth_date (must be 18+)
- SSN (US residents) or National ID (non-US)
- signed_agreement_id (Terms of Service acceptance)

**Optional/Conditional:**
- ID verification (photo ID)
- Proof of address (for SEPA/EEA)

**KYC Flow Options:**
1. **KYC Links API** (Recommended) - `POST /kyc_links`
   - Generate hosted Persona link for user to complete KYC
   - User redirected to Bridge's Persona flow
   - Simpler integration, Bridge handles UI
   
2. **Customers API** - `POST /customers`
   - Pass KYC data directly to Bridge
   - More control but more implementation work

## All Questions Resolved
- ✅ IBEX supports Tron USDT (Crypto Receive/Send API)
- ✅ Wallet address via IBEX `POST /crypto/receive-infos`
- ✅ KYC via Bridge Persona (KYC Links API)
- ✅ Fee: Bridge fees + 0.5% Flash

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
