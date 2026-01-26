# Bridge.xyz Integration Plan

## Context

### Original Request
Integrate Bridge.xyz API into Flash backend to enable USD fiat on-ramp/off-ramp for US-based users. Each Flash user completing KYC should be able to get a Bridge USD Virtual Account connected to their IBEX USD Wallet.

### Interview Summary
**Key Discussions**:
- Blockchain: Tron (TRC-20) for USDT transfers (low fees, $75B+ USDT supply)
- Stablecoin: USDT directly to user's IBEX Tron wallet address
- Customer Creation: Lazy - only when user requests on-ramp capability
- KYC: Bridge uses Persona - use KYC Links API for hosted flow
- Fees: Bridge fees + 0.5% Flash markup
- **Access Level**: Level 2+ (Pro) only
- **USDT Wallet**: Gradual migration - users get BOTH USD and USDT wallets. USD deprecated over time.
- **IBEX Integration**: IBEX sends webhook when crypto received → Flash credits balance
- **Bank Details**: Bridge handles storage, Flash only stores external_account_id reference
- **Ledger**: IBEX handles balance for now (future: Frappe ERP migration)
- **Notifications**: Minimal - only completed deposits/withdrawals
- **Feature Flag**: Config-based `bridge.enabled: true/false`

**Research Findings**:
- **Bridge.xyz**: Enhanced TRON support, memoless USDT.trx deposits, fiat↔USDT.trx on/off ramps
- **IBEX Crypto API**: `GET /crypto/receive-infos/options`, `POST /crypto/receive-infos` for Tron address
- **IBEX Webhook**: IBEX sends webhook when crypto is received (similar to existing USD webhook)
- **Bridge KYC**: Persona integration via KYC Links API (`POST /kyc_links`)
- Current Flash architecture uses IBEX for all wallet operations
- Account levels: 0 (unverified), 1 (basic KYC), 2 (Pro), 3 (Merchant)

### Metis Review
**Identified Gaps** (addressed):
- Need to verify IBEX can receive USDT on Tron (flagged as TODO in plan)
- Webhook signature verification pattern needed (included in plan)
- Error handling for Bridge API failures (included in service layer)

---

## Work Objectives

### Core Objective
Add Bridge.xyz integration to enable US bank account on-ramp (ACH/Wire → USDT) and off-ramp (USDT → ACH/Wire) for KYC-verified Flash users.

### Concrete Deliverables
- `src/services/bridge/` - Bridge API service layer
- `src/services/bridge/webhook-server/` - Webhook handling
- MongoDB schema extensions for Bridge data
- GraphQL API endpoints for Bridge operations
- `docs/bridge-integration/` - Architecture documentation
- Configuration schema for Bridge settings

### Definition of Done
- [ ] `yarn tsc-check` passes with no new errors
- [ ] Bridge service can create customers and virtual accounts
- [ ] Webhooks are received and processed
- [ ] GraphQL endpoints are accessible
- [ ] Documentation exists in `docs/bridge-integration/`

### Must Have
- Bridge API client with typed responses
- Customer creation linked to Flash accounts
- Virtual Account creation for on-ramp
- External Account management for off-ramp
- Transfer initiation for withdrawals
- Webhook server for deposit notifications
- Proper error handling and logging

### Must NOT Have (Guardrails)
- Do NOT break existing IBEX flows (only ADD new crypto receive methods/routes, no behavioral changes to current endpoints)
- Do NOT change KYC flow (just hook into completion)
- Do NOT add mobile app changes (separate repo)
- Do NOT implement JM bank integration (existing, separate)
- Do NOT add Bridge customer creation at signup (lazy creation only)
- Do NOT store sensitive bank details in logs
- Do NOT allow Bridge operations for accounts below Level 2 (Pro)
- Do NOT process webhooks without idempotency checks
- Do NOT credit wallet without IBEX webhook confirmation
- Do NOT expose Bridge internal IDs to users (use Flash account IDs)
- Do NOT skip feature flag check before Bridge operations

---

## Verification Strategy (MANDATORY)

### Test Decision
- **Infrastructure exists**: YES (Jest)
- **User wants tests**: TDD for critical paths
- **Framework**: Jest (existing)

### QA Approach
- Unit tests for Bridge client methods
- Integration tests with Bridge sandbox API
- Manual verification of webhook handling

---

## Task Flow

```
Task 1 (Config) ─┬─→ Task 2 (Bridge Types) ──→ Task 3 (Client) → Task 4 (Errors)
                 │                                      ↓
                 └─→ Task 2b (USDT Types) ──────────────┤
                                                        ↓
Task 5 (Repository) → Task 6 (Schema) → Task 7 (Service Layer)
                                          ↓
                        ┌─────────────────┼─────────────────┐
                        ↓                 ↓                 ↓
                 Task 8 (Bridge     Task 9 (GraphQL)   Task 10 (IBEX
                  Webhooks)                              Crypto Client)
                                                              ↓
                                                        Task 10b (IBEX
                                                         Crypto Webhook)
                                                              ↓
                                                        Task 11 (Docs)
```

## Parallelization

| Group | Tasks | Reason |
|-------|-------|--------|
| A | 1, 2, 2b | Independent foundation types |
| B | 8, 9, 10 | Can be done in parallel after service layer |

| Task | Depends On | Reason |
|------|------------|--------|
| 3 | 1, 2 | Client needs config and types |
| 5 | 2 | Repository needs types |
| 6 | 2 | Schema needs Bridge ID types |
| 7 | 3, 4, 5, 6 | Service layer depends on all foundations |
| 8, 9, 10 | 7 | Need service layer to call |
| 9 | 2b | GraphQL needs USDT wallet types |
| 10b | 2b, 6, 10 | Needs USDT types + Account schema + IBEX crypto client |
| 11 | 8, 9, 10b | Documentation after all code complete |

---

## TODOs

- [x] 1. Add Bridge configuration schema

  **What to do**:
  - Add Bridge config type to `src/config/schema.types.d.ts`
  - Add Bridge config schema to `src/config/schema.ts`
  - Add Bridge config export to `src/config/yaml.ts`
  - Add Bridge section to `dev/config/base-config.yaml`
  - Include `enabled: boolean` flag for feature toggle

  **Must NOT do**:
  - Do NOT add real API keys to defaults.yaml (use placeholders)

  **Parallelizable**: YES (with 2)

  **References**:
  - `src/config/schema.types.d.ts:25-35` - IbexConfig pattern to follow
  - `src/config/schema.ts:629-706` - Ibex schema definition pattern
  - `src/config/yaml.ts:389` - Config export pattern
  - `dev/config/base-config.yaml` - Default config values (NOT dev/defaults.yaml)

  **Acceptance Criteria**:
  - [ ] `BridgeConfig` type exists with:
    - `enabled: boolean` - Feature flag
    - `apiKey: string` - Bridge API key
    - `baseUrl: string` - Bridge API base URL (default: https://api.bridge.xyz)
    - `webhook.port: number` - Standalone webhook server port (e.g., 4012)
    - `webhook.publicKeys: { kyc: string, deposit: string, transfer: string }` - Per-endpoint public keys
    - `webhook.timestampSkewMs: number` - Max allowed timestamp skew (default: 300000 = 5 min)
  - [ ] Config schema validates Bridge section
  - [ ] `BridgeConfig` exported as const object from yaml.ts (like `IbexConfig`, not as function)
  - [ ] `BridgeConfig.enabled` flag controls feature availability
  - [ ] `yarn tsc-check` passes

  **Commit**: YES
  - Message: `feat(config): add Bridge.xyz configuration schema`
  - Files: `src/config/schema.types.d.ts`, `src/config/schema.ts`, `src/config/yaml.ts`, `dev/config/base-config.yaml`

---

- [ ] 2. Create Bridge TypeScript types

  **What to do**:
  - Create `src/services/bridge/index.types.d.ts` with Bridge domain types
  - Define branded ID types (these go in `src/domain/primitives/` for domain-layer visibility):
    - `BridgeCustomerId` - Add to `src/domain/primitives/bridge.ts` (new file)
    - `BridgeVirtualAccountId`, `BridgeExternalAccountId`, `BridgeTransferId`
  - Define service-layer interfaces in `src/services/bridge/index.types.d.ts`:
    - Customer, VirtualAccount, ExternalAccount, Transfer, Webhook events
  - **Type visibility**: Domain types go in `src/domain/primitives/bridge.ts` so they can be imported by `src/domain/accounts/index.types.d.ts`

  **Must NOT do**:
  - Do NOT duplicate API response types (use client types)
  - Do NOT put domain-visible types only in services/ (domain can't import from services)

  **Parallelizable**: YES (with 1)

  **References**:
  - `src/services/ibex/index.types.d.ts` - Pattern for service types
  - `src/domain/primitives/` - Pattern for branded ID types (e.g., AccountId)
  - Bridge API docs: https://apidocs.bridge.xyz/api-reference

  **Acceptance Criteria**:
  - [ ] `src/domain/primitives/bridge.ts` created with branded ID types
  - [ ] `src/services/bridge/index.types.d.ts` created with service interfaces
  - [ ] Branded types can be imported from domain layer
  - [ ] `yarn tsc-check` passes

  **Commit**: YES
  - Message: `feat(bridge): add TypeScript types for Bridge entities`
  - Files: `src/domain/primitives/bridge.ts`, `src/services/bridge/index.types.d.ts`

---

- [ ] 2b. Add USDT currency and wallet types

  **What to do**:
  - USDT is a **new currency type** (gradual migration - users have BOTH USD and USDT wallets)
  - Add `WalletCurrency.Usdt` to `src/domain/shared/primitives.ts`:
    ```typescript
    export const WalletCurrency = {
      Btc: "BTC",
      Usd: "USD",
      Jmd: "JMD",
      Usdt: "USDT",  // NEW
    } as const
    ```
  - **Update GraphQL WalletCurrency enum** in `src/graphql/shared/types/scalar/wallet-currency.ts`:
    ```typescript
    export const WalletCurrency = GT.Enum({
      name: "WalletCurrency",
      values: {
        BTC: {},
        USD: {},
        USDT: {},  // NEW
      },
    })
    ```
  - Create USDT amount types in `src/domain/fiat/`:
    - `UsdtAmount` (similar to `UsdAmount` but for USDT, uses smallest unit = 6 decimals for TRC-20 USDT)
  - Create USDT wallet type in `src/graphql/shared/types/object/`:
    - `usdt-wallet.ts` - Similar to `usd-wallet.ts` but for USDT
  - **Register UsdtWallet in GraphQL types** - Update `src/graphql/public/types/index.ts`:
    - Import `UsdtWallet`
    - Add to `ALL_INTERFACE_TYPES` array (alongside BtcWallet, UsdWallet)
    - This file uses `ALL_INTERFACE_TYPES` export, not a plain "types" array
  - **USDT Wallet Backing Model**:
    - USDT wallet is backed by IBEX crypto receive functionality (not a traditional IBEX account)
    - Balance source: IBEX tracks USDT received at Tron address internally
    - Balance query: Call IBEX `GET /crypto/receive-infos/{id}/balance` or similar
    - **Wallet Creation**: When user requests Bridge on-ramp:
      1. Call IBEX `POST /crypto/receive-infos` to create Tron USDT receive address
      2. Store receive-info ID as wallet backing reference (similar to how USD wallet stores IBEX account ID)
      3. USDT balance comes from IBEX crypto balance, not traditional account balance
    - **Crediting**: IBEX handles crediting automatically when USDT arrives. Flash just queries the updated balance.
    - This differs from USD wallet which uses `IbexClient.getBalance()` for traditional accounts
    
    **Required Code Changes for USDT Balance**:
    - `src/app/wallets/get-balance-for-wallet.ts`:
      - Currently returns `USDAmount` via `Ibex.getAccountDetails(walletId)`
      - Add currency switch: if `wallet.currency === WalletCurrency.Usdt`, call new IBEX crypto balance method
      - Return `UsdtAmount` for USDT wallets
    - `src/services/ibex/client.ts`:
      - Add `getCryptoReceiveBalance(receiveInfoId)` method
    - `src/graphql/shared/types/object/usdt-wallet.ts`:
      - Balance resolver calls `Wallets.getBalanceForWallet(...)` (same pattern as usd-wallet.ts)
      - The routing happens in get-balance-for-wallet.ts based on currency

    **USDT Wallet Persistence**:
    - USDT wallets are created **lazily** when user first requests Bridge on-ramp (not at account creation)
    - NOT added to `accounts.initialWallets` (that stays USD/BTC only)
    - Creation flow:
      1. User requests on-ramp → Bridge service checks if USDT wallet exists
      2. If not: Call IBEX `POST /crypto/receive-infos` → Get `receiveInfoId`
      3. Call `WalletsRepository.persistNew()` with:
         - `currency: WalletCurrency.Usdt`
         - `id: receiveInfoId` (the IBEX receive-info ID becomes wallet ID)
      4. Store `bridgeTronAddress` on Account for webhook lookup
    - `WalletsRepository.persistNew()` needs update to handle USDT:
      - If `currency === WalletCurrency.Usdt`: Skip IBEX account creation, use provided `receiveInfoId`
      - Otherwise: Existing behavior (create IBEX account)

  **Must NOT do**:
  - Do NOT remove or modify existing USD wallet
  - Do NOT conflate USDT with USD (different currencies)
  - Do NOT assume USDT has same decimal places as USD (USDT TRC-20 has 6 decimals)

  **Parallelizable**: YES (with 1, 2)

  **References**:
  - `src/domain/shared/primitives.ts` - WalletCurrency enum
  - `src/domain/fiat/index.ts` - UsdAmount pattern
  - `src/graphql/shared/types/object/usd-wallet.ts` - Wallet type pattern
  - `src/graphql/shared/types/scalar/wallet-currency.ts` - **GraphQL enum to update**
  - `src/graphql/public/types/index.ts` - **Type registration (MUST add UsdtWallet)**
  - `src/services/mongoose/wallets.ts` - WalletsRepository.persistNew()
  - TRC-20 USDT: 6 decimal places (1 USDT = 1,000,000 smallest units)

  **Acceptance Criteria**:
  - [ ] `WalletCurrency.Usdt` added to domain enum
  - [ ] `USDT` added to GraphQL WalletCurrency enum
  - [ ] `UsdtAmount` type created (6 decimal precision)
  - [ ] `UsdtWallet` GraphQL type created
  - [ ] `UsdtWallet` registered in `src/graphql/public/types/index.ts`
  - [ ] Wallet resolver handles USDT wallet type
  - [ ] `yarn tsc-check` passes

  **Commit**: YES
  - Message: `feat(domain): add USDT currency and wallet types`
  - Files: `src/domain/shared/primitives.ts`, `src/domain/fiat/usdt.ts`, `src/graphql/shared/types/object/usdt-wallet.ts`, `src/graphql/shared/types/scalar/wallet-currency.ts`, `src/graphql/public/types/index.ts`

---

- [ ] 3. Create Bridge API client

  **What to do**:
  - Create `src/services/bridge/client.ts`
  - Port client from `/Users/dread/Documents/Island-Bitcoin/Flash/bridge-mcp/src/bridge-client.ts` (sibling repo)
  - **EXTEND with Tron/USDT support** (bridge-mcp client doesn't have Tron types yet):
    - Add `"tron"` to `PaymentRail` type
    - Add `"usdt"` to destination currency options
    - Virtual account creation payload for Tron:
      ```typescript
      {
        source: { currency: "usd" },
        destination: {
          currency: "usdt",
          payment_rail: "tron",
          address: "T..."  // TRC-20 address
        }
      }
      ```
  - Adapt to use Flash config pattern
  - Add methods:
    - `createKycLink(customerId)` - `POST /v0/kyc_links` → Returns `{ kyc_link, tos_link, customer_id }`
    - `createCustomer(data)` - `POST /v0/customers`
    - `getCustomer(customerId)` - `GET /v0/customers/{id}`
    - `createVirtualAccount(customerId, data)` - `POST /v0/customers/{id}/virtual_accounts`
    - `getExternalAccountLinkUrl(customerId)` - `POST /v0/customers/{id}/external_accounts/link` → Returns hosted URL
    - `listExternalAccounts(customerId)` - `GET /v0/customers/{id}/external_accounts`
    - `createTransfer(customerId, data)` - `POST /v0/customers/{id}/transfers`
    - `getTransfer(customerId, transferId)` - `GET /v0/customers/{id}/transfers/{id}`

  **Must NOT do**:
  - Do NOT expose raw API responses (wrap in domain types)

  **Parallelizable**: NO (depends on 1, 2)

  **References**:
  - `/Users/dread/Documents/Island-Bitcoin/Flash/bridge-mcp/src/bridge-client.ts` - Already created Bridge client (sibling repo)
  - `src/services/ibex/client.ts:12-18` - Pattern for client initialization
  - `src/config/yaml.ts:389` - How to access config
  - Bridge API docs: https://apidocs.bridge.xyz/api-reference

  **Acceptance Criteria**:
  - [ ] Client initializes with config
  - [ ] All CRUD methods implemented: createCustomer, getCustomer, createVirtualAccount, createExternalAccount, createTransfer, getTransfer
  - [ ] Errors are properly wrapped in BridgeApiError
  - [ ] `yarn tsc-check` passes

  **Manual Verification** (with Bridge sandbox credentials):
  ```typescript
  // In test or REPL:
  import { BridgeClient } from "@/services/bridge/client"
  
  const client = new BridgeClient({
    apiKey: process.env.BRIDGE_SANDBOX_API_KEY,
    baseUrl: "https://api.sandbox.bridge.xyz"
  })
  
  // Test customer creation
  const customer = await client.createCustomer({
    type: "individual",
    first_name: "Test",
    last_name: "User", 
    email: "test@example.com"
  })
  console.log(customer.id) // Should be "cust_xxx"
  
  // Test get customer
  const fetched = await client.getCustomer(customer.id)
  console.log(fetched.kyc_status) // Should be "not_started"
  ```

  **Commit**: YES
  - Message: `feat(bridge): add Bridge API client`
  - Files: `src/services/bridge/client.ts`

---

- [ ] 4. Create Bridge error types

  **What to do**:
  - Create `src/services/bridge/errors.ts`
  - Define error types:
    - `BridgeError` - Base error
    - `BridgeApiError` - API call failures
    - `BridgeRateLimitError` - Rate limit exceeded
    - `BridgeTimeoutError` - Request timeout
    - `BridgeCustomerNotFoundError` - Customer doesn't exist
    - `BridgeKycPendingError` - KYC not yet approved
    - `BridgeKycRejectedError` - KYC was rejected
    - `BridgeInsufficientFundsError` - Not enough balance
    - `BridgeAccountLevelError` - User below Level 2
    - `BridgeDisabledError` - Feature flag is off
    - `BridgeWebhookValidationError` - Invalid webhook signature
  - Add error handler function that maps HTTP status codes to error types
  - **CRITICAL**: Update `src/graphql/error-map.ts` to map Bridge errors:
    - The `mapError()` function uses exhaustive switch with `assertUnreachable`
    - Without adding Bridge errors, GraphQL will crash on first Bridge error
    - Add cases for each Bridge error type (similar to IBEX error mappings)
    ```typescript
    // In src/graphql/error-map.ts mapError() switch:
    case "BridgeDisabledError":
      return new ValidationInternalError({ message: "Bridge integration is currently disabled", ... })
    case "BridgeAccountLevelError":
      return new NotAuthorizedError({ message: "Bridge requires Pro account (Level 2+)", ... })
    // ... etc for each error type
    ```

  **Must NOT do**:
  - Do NOT log sensitive data in errors (no SSN, full bank numbers)
  - Do NOT expose internal Bridge errors to users
  - Do NOT skip error-map.ts update (will cause runtime crashes)

  **Parallelizable**: NO (depends on 2)

  **References**:
  - `src/services/ibex/errors.ts` - Pattern for service errors
  - `src/domain/errors.ts` - Base error classes
  - `src/graphql/error-map.ts:729-741` - **MUST update** exhaustive switch

  **Acceptance Criteria**:
  - [ ] All error types defined in `src/services/bridge/errors.ts`
  - [ ] Error handler converts API errors to domain errors
  - [ ] Errors extend DomainError
  - [ ] `src/graphql/error-map.ts` updated with Bridge error mappings
  - [ ] User-facing errors don't leak internal details
  - [ ] `yarn tsc-check` passes

  **Commit**: YES
  - Message: `feat(bridge): add Bridge error types`
  - Files: `src/services/bridge/errors.ts`, `src/graphql/error-map.ts`

---

- [ ] 5. Create Bridge repository for Virtual/External Accounts

  **What to do**:
  - Create `src/services/mongoose/bridge-accounts.ts`
  - Define schemas for Bridge-specific records that DON'T belong on Account:
    - `BridgeVirtualAccountRecord` - Virtual account details (bank routing/account info)
    - `BridgeExternalAccountRecord` - User's linked bank accounts for off-ramp
    - `BridgeWithdrawalRecord` - Withdrawal transaction history
  - Implement CRUD operations for each

  **Data Model Source of Truth**:
  | Datum | Storage Location | Rationale |
  |-------|------------------|-----------|
  | `bridgeCustomerId` | Account schema | 1:1 with Account, frequently accessed |
  | `bridgeKycStatus` | Account schema | 1:1 with Account, used in auth checks |
  | `bridgeTronAddress` | Account schema | 1:1 with Account, used for webhook lookup |
  | Virtual account details | BridgeVirtualAccountRecord | Can have multiple per account, complex data |
  | External bank accounts | BridgeExternalAccountRecord | Can have multiple per account |
  | Withdrawal history | BridgeWithdrawalRecord | Audit trail, many per account |

  **Storage Policy Reconciliation**:
  - "Bridge handles storage, Flash only stores reference ID" applies to **sensitive bank data** (full routing/account numbers)
  - Flash **does store** for display/UX purposes:
    - Virtual account: `bankName`, `routingNumber` (not sensitive), `accountNumberLast4`
    - External account: `bankName`, `accountNumberLast4`, `bridgeExternalAccountId` (reference)
  - Flash **does NOT store**: Full account numbers, SSN, DOB, or any PII collected during KYC
  - Bridge is **source of truth** for: KYC documents, full bank credentials, compliance data

  **Must NOT do**:
  - Do NOT store full bank account numbers (only last 4 + bank name)
  - Do NOT store KYC PII (SSN, DOB, address details)
  - Do NOT duplicate bridgeCustomerId/kycStatus/tronAddress here (those go on Account)

  **Parallelizable**: NO (depends on 2)

  **References**:
  - `src/services/mongoose/wallets.ts` - Repository pattern
  - `src/services/mongoose/accounts.ts` - Account repository pattern

  **Acceptance Criteria**:
  - [ ] BridgeVirtualAccountRecord schema with: accountId, bridgeVirtualAccountId, bankName, routingNumber, accountNumberLast4, createdAt
  - [ ] BridgeExternalAccountRecord schema with: accountId, bridgeExternalAccountId, bankName, accountNumberLast4, createdAt
  - [ ] BridgeWithdrawalRecord schema with: accountId, bridgeTransferId, amount, status, externalAccountId, createdAt, updatedAt
  - [ ] Indexes on accountId for all collections
  - [ ] Repository functions: create, findByAccountId, updateStatus
  - [ ] `yarn tsc-check` passes

  **Commit**: YES
  - Message: `feat(bridge): add Bridge repository for virtual/external accounts`
  - Files: `src/services/mongoose/bridge-accounts.ts`, `src/services/mongoose/schema.ts`

---

- [ ] 6. Add Bridge fields to Account schema

  **What to do**:
  - Add fields to Account mongoose schema in `src/services/mongoose/schema.ts`:
    - `bridgeCustomerId: string` (optional) - Bridge customer ID
    - `bridgeKycStatus: 'pending' | 'approved' | 'rejected'` (optional) - KYC status
    - `bridgeTronAddress: string` (optional) - User's Tron USDT receive address
  - Add to Account type definition in `src/domain/accounts/index.types.d.ts`:
    ```typescript
    import type { BridgeCustomerId } from "@/domain/primitives/bridge"
    
    bridgeCustomerId?: BridgeCustomerId
    bridgeKycStatus?: 'pending' | 'approved' | 'rejected'
    bridgeTronAddress?: string
    ```
  - **CRITICAL**: Update `translateToAccount()` in `src/services/mongoose/accounts.ts`:
    - Map mongoose fields to domain Account type
    - Handle undefined/null: if field is absent, don't include in returned object
  - **CRITICAL**: Add new repository methods:
    1. **Update interface** in `src/domain/accounts/index.types.d.ts`:
       ```typescript
       interface IAccountsRepository {
         // ... existing methods
         updateBridgeFields: (
           id: AccountId,
           fields: { bridgeCustomerId?: BridgeCustomerId; bridgeKycStatus?: string; bridgeTronAddress?: string }
         ) => Promise<Account | RepositoryError>
         
         findByBridgeTronAddress: (
           address: string
         ) => Promise<Account | RepositoryError>  // For IBEX crypto webhook lookup
         
         findByBridgeCustomerId: (
           customerId: BridgeCustomerId
         ) => Promise<Account | RepositoryError>  // For Bridge KYC webhook lookup
       }
       ```
    2. **Implement methods** in `src/services/mongoose/accounts.ts`:
       ```typescript
       updateBridgeFields: async (id, fields) => {
         const result = await AccountModel.findByIdAndUpdate(
           id,
           { $set: fields },
           { new: true }
         )
         if (!result) return new RepositoryError("Account not found")
         return translateToAccount(result)
       },
       
       findByBridgeTronAddress: async (address) => {
         const result = await AccountModel.findOne({ bridgeTronAddress: address })
         if (!result) return new RepositoryError("Account not found for Tron address")
         return translateToAccount(result)
       },
       
       findByBridgeCustomerId: async (customerId) => {
         const result = await AccountModel.findOne({ bridgeCustomerId: customerId })
         if (!result) return new RepositoryError("Account not found for Bridge customer ID")
         return translateToAccount(result)
       }
       ```
    3. **Add index** in `src/services/mongoose/schema.ts`:
       ```typescript
       // In AccountSchema definition, add:
       AccountSchema.index({ bridgeTronAddress: 1 }, { sparse: true })
       ```
    - Service layer uses `updateBridgeFields()` for Bridge operations
    - Webhook handler uses `findByBridgeTronAddress()` to identify account
    - Existing `update()` remains unchanged to avoid breaking other code
  - Add index on `bridgeTronAddress` for webhook address lookup

  **Must NOT do**:
  - Do NOT make any Bridge fields required (lazy creation)
  - Do NOT store sensitive Bridge data (SSN, DOB)
  - Do NOT overwrite existing fields when updating Bridge fields

  **Parallelizable**: NO (depends on 2)

  **References**:
  - `src/services/mongoose/schema.ts` - Account schema (add fields here)
  - `src/domain/accounts/index.types.d.ts` - Account type (add types here)
  - `src/services/mongoose/accounts.ts` - AccountsRepository:
    - `translateToAccount()` function - must map new fields
    - `update()` method - must handle new fields

  **Acceptance Criteria**:
  - [ ] bridgeCustomerId field added to mongoose schema (optional string)
  - [ ] bridgeKycStatus field added to mongoose schema (optional enum)
  - [ ] bridgeTronAddress field added to mongoose schema (optional string)
  - [ ] Index created on bridgeTronAddress (sparse index in `src/services/mongoose/schema.ts`)
  - [ ] `src/domain/accounts/index.types.d.ts` - `Account` type includes new optional fields
  - [ ] `src/domain/accounts/index.types.d.ts` - `IAccountsRepository` interface includes `updateBridgeFields` method
  - [ ] `src/domain/accounts/index.types.d.ts` - `IAccountsRepository` interface includes `findByBridgeTronAddress` method
  - [ ] `src/domain/accounts/index.types.d.ts` - `IAccountsRepository` interface includes `findByBridgeCustomerId` method
  - [ ] `translateToAccount()` maps all Bridge fields correctly
  - [ ] `updateBridgeFields()` implemented in `src/services/mongoose/accounts.ts`
  - [ ] `findByBridgeTronAddress()` implemented in `src/services/mongoose/accounts.ts`
  - [ ] `findByBridgeCustomerId()` implemented in `src/services/mongoose/accounts.ts`
  - [ ] Existing `update()` unchanged (no regression to other call sites)
  - [ ] `yarn tsc-check` passes

  **Verification**:
  ```typescript
  // In test or REPL, verify partial update works:
  const account = await AccountsRepository().findById(testAccountId)
  const originalUsername = account.username
  
  const updated = await AccountsRepository().updateBridgeFields(testAccountId, {
    bridgeCustomerId: 'cust_123',
    bridgeKycStatus: 'pending'
  })
  
  // Verify Bridge fields updated
  assert(updated.bridgeCustomerId === 'cust_123')
  assert(updated.bridgeKycStatus === 'pending')
  
  // Verify other fields NOT overwritten
  assert(updated.username === originalUsername)
  ```

  **Commit**: YES
  - Message: `feat(accounts): add Bridge integration fields`
  - Files: `src/services/mongoose/schema.ts`, `src/domain/accounts/index.types.d.ts`, `src/services/mongoose/accounts.ts`

---

- [ ] 7. Create Bridge service layer

  **What to do**:
  - Create `src/services/bridge/index.ts` - public API
  - Implement methods:
    - `initiateKyc(accountId)` → Returns KYC link, stores bridgeCustomerId
    - `createVirtualAccount(accountId)` → Creates virtual account with IBEX Tron address
    - `addExternalAccount(accountId)` → Returns Bridge hosted bank linking URL
    - `initiateWithdrawal(accountId, amount, externalAccountId)` → Orchestrates IBEX → Bridge
    - `getKycStatus(accountId)` → Returns KYC status
    - `getVirtualAccount(accountId)` → Returns virtual account details
    - `getExternalAccounts(accountId)` → Lists linked bank accounts
  - **Every method MUST**:
    - Check `BridgeConfig.enabled` config flag first (throw BridgeDisabledError if false)
      - Note: Config is exported as object, not function (like `IbexConfig`, not `IbexConfig()`)
    - Check `account.level >= 2` (throw BridgeAccountLevelError if not)
    - Log operation start/end with correlation ID
    - Handle errors and convert to domain errors
  - Wire up client, repository, and error handling
  - Add OpenTelemetry tracing using `wrapAsyncFunctionsToRunInSpan` pattern

  **Must NOT do**:
  - Do NOT expose internal implementation details
  - Do NOT allow operations for Level 0/1 accounts
  - Do NOT skip feature flag check
  - Do NOT skip tracing

  **Parallelizable**: NO (depends on 3, 4, 5, 6)

  **References**:
  - `src/services/ibex/index.ts` - Service export pattern
  - `src/services/ledger/index.ts` - Complex service pattern
  - `src/services/tracing.ts` - OpenTelemetry tracing with `wrapAsyncFunctionsToRunInSpan`
  - `src/domain/accounts/index.types.d.ts` - Account levels

  **Acceptance Criteria**:
  - [ ] All public methods implemented
  - [ ] Every method checks bridge.enabled first (throws BridgeDisabledError)
  - [ ] Every method checks account.level >= 2 (throws BridgeAccountLevelError)
  - [ ] Proper error handling with domain errors
  - [ ] Logging with pino logger includes:
    - `traceId` from OpenTelemetry context (use `recordExceptionInCurrentSpan` pattern)
    - `accountId` for audit trail
    - Operation name and result (success/error)
  - [ ] OpenTelemetry spans for all methods (use `wrapAsyncFunctionsToRunInSpan` pattern from `src/services/tracing.ts`)
  - [ ] `yarn tsc-check` passes

  **Commit**: YES
  - Message: `feat(bridge): add Bridge service layer`
  - Files: `src/services/bridge/index.ts`

---

- [ ] 8. Create Bridge webhook server (standalone)

  **What to do**:
  - Create standalone Express server at `src/services/bridge/webhook-server/index.ts`
    - Pattern: Follow `src/services/ibex/webhook-server/index.ts` structure
    - Runs on `BridgeConfig.webhook.port` (e.g., 4012)
  - **Create entrypoint**: `src/servers/bridge-webhook-server.ts` (new file)
    - Pattern: Follow `src/servers/ibex-webhook-server.ts`
    - Imports and starts the Bridge webhook server
    - Add to `package.json` scripts: `"bridge-webhook": "ts-node src/servers/bridge-webhook-server.ts"`
  - Create routes (all under `/` base path, no `/bridge/webhook` prefix):
    - `POST /kyc` - KYC status webhooks
    - `POST /deposit` - Deposit completion webhooks  
    - `POST /transfer` - Transfer status webhooks
    - Configure in Bridge dashboard: `https://your-domain.com:4012/kyc`, etc.
  - Create middleware for Bridge signature verification:
    - **Bridge uses asymmetric signature verification** (NOT HMAC)
    - Parse `X-Webhook-Signature` header: `t=<timestamp_ms>,v0=<base64_signature>`
    - Verify signature using Bridge's per-endpoint `public_key` (stored in config)
    - Verify timestamp is within acceptable skew (e.g., 5 minutes)
    - **CRITICAL**: Must capture raw request body for signature verification
      - Configure Express with `express.raw()` or `bodyParser.raw()` before JSON parsing
      - Or use `verify` callback in `express.json({ verify: (req, res, buf) => req.rawBody = buf })`
  - Handle webhooks:
    - `kyc.approved` → Update Account.bridgeKycStatus = 'approved'
    - `kyc.rejected` → Update Account.bridgeKycStatus = 'rejected', log reason
    - `deposit.completed` → Log deposit event, amount, tx hash (IBEX webhook handles balance)
    - `transfer.completed` → Update withdrawal status to 'completed', send notification
    - `transfer.failed` → Update withdrawal status to 'failed', send notification
  - **IMPORTANT**: Deposit balance is credited when IBEX sends its webhook, NOT when Bridge webhook arrives
  - **Response strategy**: Return 200 for successfully received webhooks. Return 401 for invalid signatures.

  **Must NOT do**:
  - Do NOT use HMAC for signature verification (Bridge uses asymmetric public key)
  - Do NOT credit wallet on Bridge deposit webhook (wait for IBEX webhook)
  - Do NOT process without idempotency check (use LockService pattern)
  - Do NOT lose raw body bytes (needed for signature verification)

  **Parallelizable**: YES (with 9, after 7)

  **References**:
  - `src/services/ibex/webhook-server/` - Webhook server structure pattern
  - `src/services/lock/index.ts` - LockService for idempotency
  - Bridge webhook signature docs: https://apidocs.bridge.xyz/platform/additional-information/webhooks/signature
    - Header: `X-Webhook-Signature: t=<timestamp_ms>,v0=<base64_signature>`
    - Verification: Use Bridge's public key to verify signature over `<timestamp>.<raw_body>`
  - Express raw body capture: https://expressjs.com/en/api.html#express.json (verify callback)

  **Acceptance Criteria**:
  - [ ] `src/servers/bridge-webhook-server.ts` entrypoint created
  - [ ] `package.json` has `bridge-webhook` script
  - [ ] Server starts on configured port (`yarn bridge-webhook`)
  - [ ] Raw body captured for signature verification
  - [ ] Signature verification uses Bridge public key (not HMAC)
  - [ ] Timestamp skew rejected (>5 min old)
  - [ ] Invalid signatures return 401
  - [ ] KYC webhooks update Account.bridgeKycStatus
  - [ ] Deposit webhook logs event (does NOT credit balance)
  - [ ] Transfer webhook updates withdrawal status
  - [ ] Idempotency: same event ID processed only once
  - [ ] `yarn tsc-check` passes

  **Manual Verification**:
  ```bash
  # Start the webhook server
  yarn bridge-webhook
  # Expected: Server listening on port 4012 (or configured port)
  
  # Test webhook endpoint is accessible (note: routes are at root, not /bridge/webhook)
  curl -X POST http://localhost:4012/deposit \
    -H "Content-Type: application/json" \
    -H "X-Webhook-Signature: t=invalid,v0=invalid" \
    -d '{"event":"deposit.completed"}'
  # Expected: 401 Unauthorized (invalid signature)
  ```

  **Commit**: YES
  - Message: `feat(bridge): add webhook server for Bridge events`
  - Files: `src/services/bridge/webhook-server/index.ts`, `src/services/bridge/webhook-server/routes/`, `src/services/bridge/webhook-server/middleware/`, `src/servers/bridge-webhook-server.ts`, `package.json`

---

- [ ] 9. Add GraphQL endpoints for Bridge

  **What to do**:
  
  **Step 1: Create GraphQL types** in `src/graphql/public/types/object/`:
  - `bridge-kyc-link.ts` - BridgeKycLink type (kycLink, tosLink)
  - `bridge-virtual-account.ts` - BridgeVirtualAccount type (bankName, routingNumber, accountNumberLast4)
  - `bridge-external-account.ts` - BridgeExternalAccount type (id, bankName, accountNumberLast4)
  - `bridge-withdrawal.ts` - BridgeWithdrawal type (id, amount, status, createdAt)

  **Step 2: Create mutation resolvers** in `src/graphql/public/root/mutation/`:
  - `bridge-initiate-kyc.ts` → Returns KYC link for Persona flow
  - `bridge-create-virtual-account.ts` → Creates virtual account with Tron destination
  - `bridge-add-external-account.ts` → Returns Bridge hosted bank linking URL
  - `bridge-initiate-withdrawal.ts` → Initiates USDT → USD withdrawal

  **Step 3: Create query resolvers** in `src/graphql/public/root/query/`:
  - `bridge-kyc-status.ts` → Returns user's Bridge KYC status
  - `bridge-virtual-account.ts` → Returns virtual account details (bank info)
  - `bridge-external-accounts.ts` → List user's linked bank accounts
  - `bridge-withdrawals.ts` → List withdrawal history

  **Step 4: CRITICAL - Register in GraphQL schema**:
  - Update `src/graphql/public/mutations.ts`:
    - Import all bridge mutation resolvers
    - Add to MutationFields object (under authenticated scope)
  - Update `src/graphql/public/queries.ts`:
    - Import all bridge query resolvers
    - Add to QueryFields object (under authenticated scope)

  **Step 5: Add authorization checks in each resolver** (return errors, don't throw):
  ```typescript
  // This codebase returns { errors: [...] } instead of throwing
  // Pattern from: src/graphql/public/root/mutation/user-update-username.ts
  
  resolve: async (_, args, { domainAccount }: GraphQLPublicContextAuth) => {
    // Check feature flag
    if (!BridgeConfig.enabled) {
      return { errors: [mapAndParseErrorForGqlResponse(new BridgeDisabledError())] }
    }
    
    // Check account level
    if (!domainAccount || domainAccount.level < 2) {
      return { errors: [mapAndParseErrorForGqlResponse(new BridgeAccountLevelError())] }
    }
    
    // ... rest of resolver
    const result = await BridgeService.someMethod(...)
    if (result instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(result)] }
    }
    return { bridge: result }
  }
  ```

  **Must NOT do**:
  - Do NOT expose raw Bridge IDs directly - use Flash's internal DB record IDs
  - Do NOT expose full bank account numbers (only last 4 digits)
  - Do NOT allow operations without authentication
  - Do NOT allow operations for accounts below Level 2
  - Do NOT allow operations if bridge.enabled=false
  - Do NOT forget to register in mutations.ts/queries.ts (endpoints won't appear!)

  **GraphQL ID Policy**:
  | Entity | GraphQL `id` field | Internal mapping |
  |--------|-------------------|------------------|
  | BridgeVirtualAccount | Flash DB ObjectId | Record stores `bridgeVirtualAccountId` internally |
  | BridgeExternalAccount | Flash DB ObjectId | Record stores `bridgeExternalAccountId` internally |
  | BridgeWithdrawal | Flash DB ObjectId | Record stores `bridgeTransferId` internally |
  
  - GraphQL clients use Flash's stable IDs
  - Flash maps to Bridge IDs internally when calling Bridge API
  - This allows Flash to control ID format and prevents Bridge ID leakage

  **Parallelizable**: YES (with 8, after 7)

  **References**:
  - `src/graphql/public/root/mutation/user-update-username.ts` - **Mutation resolver pattern** (returns `{ errors: [...] }` style)
  - `src/graphql/public/root/query/me.ts` - Query resolver pattern
  - `src/graphql/public/types/object/consumer-account.ts` - Object type definition pattern
  - `src/graphql/shared/types/object/usd-wallet.ts` - Wallet type pattern (in shared, not public)
  - `src/graphql/error-map.ts` - `mapAndParseErrorForGqlResponse()` for error handling
  - `src/graphql/public/mutations.ts` - **Mutation registration** (MUST update)
  - `src/graphql/public/queries.ts` - **Query registration** (MUST update)
  - `src/domain/accounts/index.types.d.ts` - Account levels

  **Acceptance Criteria**:
  - [ ] All 4 GraphQL types created in types/object/
  - [ ] All 4 mutation resolvers created
  - [ ] All 4 query resolvers created
  - [ ] Mutations registered in `src/graphql/public/mutations.ts`
  - [ ] Queries registered in `src/graphql/public/queries.ts`
  - [ ] All mutations check account.level >= 2
  - [ ] All mutations check bridge.enabled
  - [ ] Returns error for Level 0/1 accounts
  - [ ] Returns error if bridge.enabled=false
  - [ ] Bank details show only last 4 digits
  - [ ] `yarn tsc-check` passes

  **Manual Verification** (after server running):
  ```graphql
  # Test query (should work for Level 2+ user)
  query {
    bridgeKycStatus
  }
  # Expected: "pending" | "approved" | "rejected" | null
  
  # Test mutation (should work for Level 2+ user)
  mutation {
    bridgeInitiateKyc {
      kycLink
      tosLink
    }
  }
  # Expected: { kycLink: "https://...", tosLink: "https://..." }
  
  # Test auth (should fail for Level 1 user)
  # Expected: BridgeAccountLevelError
  ```

  **Commit**: YES
  - Message: `feat(graphql): add Bridge API endpoints`
  - Files: `src/graphql/public/root/mutation/bridge-*.ts`, `src/graphql/public/root/query/bridge-*.ts`, `src/graphql/public/types/object/bridge-*.ts`

---

- [ ] 10. Add IBEX Crypto methods for Tron address

  **What to do**:
  - Add `getCryptoReceiveOptions()` to `src/services/ibex/client.ts`
  - Add `createCryptoReceiveInfo()` to generate Tron USDT address
  - Add types for crypto receive options and responses
  - Use this to get user's Tron address for Bridge Virtual Account destination

  **Must NOT do**:
  - Do NOT change existing IBEX methods
  - Do NOT hardcode option IDs (fetch dynamically)

  **Parallelizable**: YES (with 3, independent IBEX work)

  **References**:
  - `src/services/ibex/client.ts` - Existing IBEX client
  - IBEX API: `GET /crypto/receive-infos/options`
  - IBEX API: `POST /crypto/receive-infos`

  **Acceptance Criteria**:
  - [ ] Can fetch Tron USDT receive options
  - [ ] Can generate Tron USDT address for a wallet
  - [ ] Address is valid TRC-20 format (starts with T, 34 chars)
  - [ ] `yarn tsc-check` passes

  **Commit**: YES
  - Message: `feat(ibex): add crypto receive methods for Tron USDT`
  - Files: `src/services/ibex/client.ts`, `src/services/ibex/types.ts`

---

- [ ] 10b. Add IBEX crypto webhook handler for USDT deposits

  **What to do**:
  - Extend `src/services/ibex/webhook-server/` to handle crypto receive events
  - Create new route: `src/services/ibex/webhook-server/routes/crypto-receive.ts`
  - Handle IBEX crypto webhook event (when USDT arrives at Tron address):
    - Parse event payload: tx_hash, address, amount, currency (USDT), network (Tron)
    - Lookup Account by `bridgeTronAddress` field
    - Credit user's **USDT wallet** balance (using new `WalletCurrency.Usdt` type from Task 2b)
    - Convert amount using 6 decimal precision (TRC-20 USDT standard)
    - Send push notification: "Deposit complete: X USDT"
  - Register route in `src/services/ibex/webhook-server/index.ts`
  - **Address → Account mapping**: Query `AccountsRepository` by `bridgeTronAddress` field

  **Must NOT do**:
  - Do NOT credit without idempotency check (use tx_hash as key)
  - Do NOT modify existing IBEX webhook routes

  **Parallelizable**: NO (depends on 6, 10)

  **References**:
  - `src/services/ibex/webhook-server/routes/on-receive.ts` - Existing receive webhook pattern
  - `src/services/ibex/webhook-server/index.ts` - Route registration
  - `src/services/mongoose/accounts.ts` - `findByBridgeTronAddress()` for address lookup (from Task 6)
  - `src/services/notifications/index.ts` - Push notification pattern

  **IBEX Crypto Webhook Payload** (verify with IBEX docs):
  ```json
  {
    "event": "crypto.received",
    "data": {
      "tx_hash": "abc123...",
      "address": "TXyz...",
      "amount": "100.00",
      "currency": "USDT",
      "network": "tron",
      "account_id": "ibex-account-id"
    }
  }
  ```

  **Acceptance Criteria**:
  - [ ] New route registered in IBEX webhook server
  - [ ] Can lookup Account by bridgeTronAddress
  - [ ] Credits USDT to correct user wallet
  - [ ] Idempotency: same tx_hash processed only once
  - [ ] Push notification sent on success
  - [ ] `yarn tsc-check` passes

  **Commit**: YES
  - Message: `feat(ibex): add crypto receive webhook handler for USDT deposits`
  - Files: `src/services/ibex/webhook-server/routes/crypto-receive.ts`, `src/services/ibex/webhook-server/index.ts`

---

- [ ] 11. Create documentation

  **What to do**:
  - Create `docs/bridge-integration/ARCHITECTURE.md` - system architecture
  - Create `docs/bridge-integration/API.md` - GraphQL API reference
  - Create `docs/bridge-integration/WEBHOOKS.md` - webhook handling
  - Create `docs/bridge-integration/FLOWS.md` - on-ramp/off-ramp flows with diagrams

  **Must NOT do**:
  - Do NOT include real API keys or secrets

  **Parallelizable**: YES (after 7, 8, 9, 10)

  **References**:
  - `DEV.md` - Existing dev docs pattern
  - `README.md` - Existing readme pattern

  **Acceptance Criteria**:
  - [ ] Architecture diagram included (matching user's original diagram)
  - [ ] On-ramp flow documented (US Bank → Bridge → IBEX Tron → User Wallet)
  - [ ] Off-ramp flow documented (User Wallet → Bridge → US Bank)
  - [ ] All GraphQL endpoints documented
  - [ ] Webhook events documented
  - [ ] Fee structure documented (Bridge fees + 0.5% Flash)

  **Commit**: YES
  - Message: `docs: add Bridge integration documentation`
  - Files: `docs/bridge-integration/*.md`

---

## Commit Strategy

| After Task | Message | Files | Verification |
|------------|---------|-------|--------------|
| 1 | `feat(config): add Bridge.xyz configuration schema` | config/*, dev/config/* | yarn tsc-check |
| 2 | `feat(bridge): add TypeScript types for Bridge entities` | domain/primitives/bridge.ts, services/bridge/*.d.ts | yarn tsc-check |
| 2b | `feat(domain): add USDT currency and wallet types` | domain/shared/primitives.ts, domain/fiat/usdt.ts, graphql/shared/*, graphql/public/types/index.ts | yarn tsc-check |
| 3 | `feat(bridge): add Bridge API client` | services/bridge/client.ts | yarn tsc-check |
| 4 | `feat(bridge): add Bridge error types` | services/bridge/errors.ts, graphql/error-map.ts | yarn tsc-check |
| 5 | `feat(bridge): add Bridge repository for virtual/external accounts` | services/mongoose/* | yarn tsc-check |
| 6 | `feat(accounts): add Bridge integration fields` | mongoose/*, domain/* | yarn tsc-check |
| 7 | `feat(bridge): add Bridge service layer` | services/bridge/index.ts | yarn tsc-check |
| 8 | `feat(bridge): add webhook server for Bridge events` | services/bridge/webhook-server/*, servers/bridge-webhook-server.ts | yarn tsc-check |
| 9 | `feat(graphql): add Bridge API endpoints` | graphql/public/* | yarn tsc-check |
| 10 | `feat(ibex): add crypto receive methods for Tron USDT` | services/ibex/client.ts | yarn tsc-check |
| 10b | `feat(ibex): add crypto receive webhook handler` | services/ibex/webhook-server/* | yarn tsc-check |
| 11 | `docs: add Bridge integration documentation` | docs/bridge-integration/* | N/A |

---

## Success Criteria

### Verification Commands
```bash
yarn tsc-check  # Expected: no new errors
yarn test:unit  # Expected: all pass (after adding tests)
```

### Final Checklist
- [ ] All "Must Have" features present
- [ ] All "Must NOT Have" guardrails respected
- [ ] TypeScript compiles without errors
- [ ] Documentation complete
- [ ] Webhook server handles Bridge events
- [ ] GraphQL endpoints work with authentication

---

## Resolved Items

| Item | Resolution |
|------|------------|
| **IBEX Tron Support** | ✅ IBEX Crypto API supports Tron USDT via `POST /crypto/receive-infos` |
| **KYC Data** | ✅ Use Bridge KYC Links API (`POST /kyc_links`) - Persona hosted flow |
| **Fee Structure** | ✅ Bridge fees + 0.5% Flash markup |
| **Wallet Address** | ✅ Call IBEX `POST /crypto/receive-infos` with Tron/USDT options |

## Remaining Setup Items

1. **Webhook URL**: Set up production Bridge webhook endpoint (DNS, SSL)
2. **Bridge API Key**: Obtain production API key from Bridge dashboard
3. **IBEX Crypto Options**: Verify exact `currency_id` and `network_id` for Tron USDT

---

## Technical Details

### Key Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Access Level** | Level 2+ (Pro) only | Bridge KYC + Pro account required |
| **USDT Wallet** | Gradual migration (users have both) | New USDT wallet alongside existing USD wallet. USD deprecated over time. |
| **IBEX Integration** | IBEX sends webhook on USDT receipt | Flash credits balance on webhook |
| **Bank Details** | Bridge stores | Flash only keeps external_account_id |
| **Ledger** | IBEX handles balance | Future: Frappe ERP migration |
| **Feature Flag** | Config: `bridge.enabled` | Can disable without code changes |
| **Notifications** | Minimal | Only completed deposits/withdrawals |

### On-Ramp Flow (Deposit: USD → USDT)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ PREREQUISITE: User must be Level 2+ (Pro) and bridge.enabled=true          │
└─────────────────────────────────────────────────────────────────────────────┘

1. User (Level 2+) requests on-ramp
   → Flash checks: account.level >= 2, bridge.enabled
   → Flash calls Bridge POST /kyc_links
   → Bridge returns: kyc_link, tos_link, customer_id
   → Flash stores bridgeCustomerId on Account

2. User completes KYC
   → User opens kyc_link → Persona hosted flow
   → Bridge webhook: kyc.approved
   → Flash updates bridgeKycStatus = 'approved'

3. Flash creates USDT receive address
   → GET IBEX /crypto/receive-infos/options → Get Tron USDT option
   → POST IBEX /crypto/receive-infos with wallet_id, option_id
   → Returns: Tron USDT address (TRC-20)

4. Flash creates Bridge Virtual Account
   → POST Bridge /customers/{id}/virtual_accounts:
     - source.currency: "usd"
     - destination.currency: "usdt"  
     - destination.payment_rail: "tron"
     - destination.address: user's Tron USDT address
   → Returns: Bank routing#, account# for ACH/Wire

5. User deposits USD
   → User sends ACH/Wire to Bridge bank details
   → Bridge receives USD, converts to USDT
   → Bridge sends USDT to user's Tron address
   → Bridge webhook: deposit.completed (records amount, tx hash)

6. USDT arrives at IBEX
   → IBEX receives USDT on Tron address
   → IBEX webhook to Flash: crypto.received
   → Flash credits user's USDT wallet balance
   → Flash sends push notification: "Deposit complete: X USDT"
```

### Off-Ramp Flow (Withdrawal: USDT → USD)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ PREREQUISITE: User has Bridge customer with KYC approved                    │
└─────────────────────────────────────────────────────────────────────────────┘

1. User adds bank account
   → Flash redirects to Bridge hosted flow for bank linking
   → Bridge returns: external_account_id
   → Flash stores reference only (no bank details)

2. User requests withdrawal
   → Flash validates: sufficient USDT balance, Bridge KYC approved
   → Flash calls IBEX to send USDT to Bridge liquidation address
   → IBEX initiates on-chain transfer

3. Bridge receives USDT
   → Bridge detects USDT on liquidation address
   → Bridge converts USDT → USD
   → Bridge initiates ACH/Wire to user's bank

4. Transfer completes
   → Bridge webhook: transfer.completed
   → Flash updates withdrawal status
   → Flash sends push notification: "Withdrawal complete: $X to [bank name]"
```

### Bridge KYC Links API Flow
```
1. User requests on-ramp → Flash calls POST /kyc_links
2. Bridge returns: kyc_link, tos_link, customer_id
3. User opens kyc_link → Persona hosted KYC flow
4. User completes KYC → Bridge sends webhook (kyc.approved)
5. Flash stores customer_id, creates Virtual Account
```

### IBEX Tron Address Generation
```
1. Call GET /crypto/receive-infos/options → Get Tron USDT option IDs
2. Call POST /crypto/receive-infos with:
   - account_id: user's IBEX wallet ID
   - crypto_option_id: Tron USDT receive option
3. Returns: Tron USDT address for user
4. Pass address to Bridge Virtual Account destination
```

### Fee Calculation
```
user_receives = deposit_amount - bridge_fee - (deposit_amount * 0.005)
flash_revenue = deposit_amount * 0.005  // 0.5% markup
```

### Webhook Events to Handle

| Source | Event | Flash Action |
|--------|-------|--------------|
| Bridge | `kyc.approved` | Update bridgeKycStatus, enable virtual account creation |
| Bridge | `kyc.rejected` | Update bridgeKycStatus, notify user |
| Bridge | `deposit.completed` | Log deposit, wait for IBEX webhook |
| Bridge | `transfer.completed` | Update withdrawal status, notify user |
| Bridge | `transfer.failed` | Update status, notify user, may need refund logic |
| IBEX | `crypto.received` | Credit user's USDT wallet, notify user |

### Webhook Payload Shapes (Bridge)

**KYC Approved** (lookup by `customer_id` → `findByBridgeCustomerId`):
```json
{
  "id": "evt_abc123",           // Idempotency key
  "type": "kyc.approved",
  "data": {
    "customer_id": "cust_xyz",  // Lookup key → Account.bridgeCustomerId
    "kyc_status": "approved"
  }
}
```

**Deposit Completed** (lookup by `destination_address`):
```json
{
  "id": "evt_def456",           // Idempotency key
  "type": "deposit.completed", 
  "data": {
    "customer_id": "cust_xyz",
    "virtual_account_id": "va_123",
    "destination_address": "TXyz...",  // Can also lookup by this
    "amount": "100.00",
    "currency": "usdt",
    "tx_hash": "abc..."
  }
}
```

**Transfer Completed/Failed** (lookup by `transfer_id` → `BridgeWithdrawalRecord`):
```json
{
  "id": "evt_ghi789",           // Idempotency key
  "type": "transfer.completed",
  "data": {
    "transfer_id": "tr_123",    // Lookup key → BridgeWithdrawalRecord.bridgeTransferId
    "customer_id": "cust_xyz",
    "amount": "50.00",
    "status": "completed"
  }
}
```

### Required Repository Methods (from webhook needs)

| Method | Lookup Key | Used By |
|--------|------------|---------|
| `findByBridgeCustomerId(customerId)` | `bridgeCustomerId` | KYC webhooks |
| `findByBridgeTronAddress(address)` | `bridgeTronAddress` | IBEX crypto webhook |
| `BridgeWithdrawalRepo.findByTransferId(transferId)` | `bridgeTransferId` | Transfer webhooks |

### Idempotency Strategy

All webhook handlers must be idempotent:
- Use Bridge event ID / transfer ID as idempotency key
- Check if event already processed before acting
- Pattern: `src/services/lock/index.ts` (LockService)

---

## Edge Cases & Error Handling

### Deposit Edge Cases

| Scenario | Detection | Handling |
|----------|-----------|----------|
| Deposit below minimum | Bridge rejects | Return Bridge error to user |
| Deposit above limit | Bridge rejects | Return Bridge error to user |
| Bridge KYC approved but IBEX Tron address fails | IBEX API error | Retry 3x, then show error, don't create virtual account |
| Bridge webhook arrives but IBEX webhook never comes | Timeout (24h?) | Alert ops team, may need manual reconciliation |
| Duplicate deposit webhook | Idempotency check | Skip processing, return 200 |
| User's Bridge customer suspended | Bridge API error | Show error, suggest contacting support |

### Withdrawal Edge Cases

| Scenario | Detection | Handling |
|----------|-----------|----------|
| Insufficient USDT balance | Pre-check before initiating | Return error before calling Bridge |
| Bank account closed/invalid | Bridge transfer.failed webhook | Update status, notify user |
| Bridge API timeout | HTTP timeout | Retry 3x with backoff, then fail |
| IBEX fails to send USDT | IBEX API error | Don't create Bridge transfer, return error |
| Withdrawal already in progress | Check pending withdrawals | Block new withdrawal until current completes |

### Account Edge Cases

| Scenario | Detection | Handling |
|----------|-----------|----------|
| User downgrades from Level 2 | Account level change | Block new Bridge ops, allow existing to complete |
| User closes Flash account | Account deletion flow | Complete pending ops, then cleanup Bridge customer |
| Bridge feature disabled mid-operation | Config change | Allow in-flight ops to complete, block new ones |
