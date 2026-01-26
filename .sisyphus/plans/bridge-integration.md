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

**Research Findings**:
- **Bridge.xyz**: Enhanced TRON support, memoless USDT.trx deposits, fiat↔USDT.trx on/off ramps
- **IBEX Crypto API**: `GET /crypto/receive-infos/options`, `POST /crypto/receive-infos` for Tron address
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
- Do NOT modify existing IBEX integration
- Do NOT change KYC flow (just hook into completion)
- Do NOT add mobile app changes (separate repo)
- Do NOT implement JM bank integration (existing, separate)
- Do NOT add Bridge customer creation at signup (lazy creation only)
- Do NOT store sensitive bank details in logs

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
Task 1 (Config) → Task 2 (Types) → Task 3 (Client) → Task 4 (Errors)
                                          ↓
Task 5 (Repository) → Task 6 (Schema) → Task 7 (Service Layer)
                                          ↓
Task 8 (Webhooks) → Task 9 (GraphQL) → Task 10 (Docs)
```

## Parallelization

| Group | Tasks | Reason |
|-------|-------|--------|
| A | 1, 2 | Independent foundation |
| B | 8, 9 | Can be done in parallel after service layer |

| Task | Depends On | Reason |
|------|------------|--------|
| 3 | 1, 2 | Client needs config and types |
| 5 | 2 | Repository needs types |
| 7 | 3, 4, 5, 6 | Service layer depends on all foundations |
| 8, 9 | 7 | Need service layer to call |

---

## TODOs

- [ ] 1. Add Bridge configuration schema

  **What to do**:
  - Add Bridge config type to `src/config/schema.types.d.ts`
  - Add Bridge config schema to `src/config/schema.ts`
  - Add Bridge config export to `src/config/yaml.ts`
  - Add Bridge section to `dev/defaults.yaml`

  **Must NOT do**:
  - Do NOT add real API keys to defaults.yaml (use placeholders)

  **Parallelizable**: YES (with 2)

  **References**:
  - `src/config/schema.types.d.ts:25-35` - IbexConfig pattern to follow
  - `src/config/schema.ts:629-706` - Ibex schema definition pattern
  - `src/config/yaml.ts:389` - Config export pattern
  - `dev/defaults.yaml` - Default config values

  **Acceptance Criteria**:
  - [ ] `BridgeConfig` type exists with apiKey, baseUrl, webhookSecret, etc.
  - [ ] Config schema validates Bridge section
  - [ ] `BridgeConfig` exported from yaml.ts
  - [ ] `yarn tsc-check` passes

  **Commit**: YES
  - Message: `feat(config): add Bridge.xyz configuration schema`
  - Files: `src/config/schema.types.d.ts`, `src/config/schema.ts`, `src/config/yaml.ts`, `dev/defaults.yaml`

---

- [ ] 2. Create Bridge TypeScript types

  **What to do**:
  - Create `src/services/bridge/index.types.d.ts` with Bridge domain types
  - Define: BridgeCustomerId, BridgeVirtualAccountId, BridgeExternalAccountId, BridgeTransferId
  - Define interfaces for: Customer, VirtualAccount, ExternalAccount, Transfer, Webhook events

  **Must NOT do**:
  - Do NOT duplicate API response types (use client types)

  **Parallelizable**: YES (with 1)

  **References**:
  - `src/services/ibex/index.types.d.ts` - Pattern for service types
  - Bridge API docs: https://apidocs.bridge.xyz/api-reference

  **Acceptance Criteria**:
  - [ ] All Bridge entity types defined
  - [ ] Branded types for IDs (BridgeCustomerId, etc.)
  - [ ] `yarn tsc-check` passes

  **Commit**: YES
  - Message: `feat(bridge): add TypeScript types for Bridge entities`
  - Files: `src/services/bridge/index.types.d.ts`

---

- [ ] 3. Create Bridge API client

  **What to do**:
  - Create `src/services/bridge/client.ts`
  - Port client from `../bridge-mcp/src/bridge-client.ts` (already created)
  - Adapt to use Flash config pattern
  - Add methods: createCustomer, getCustomer, createVirtualAccount, createExternalAccount, createTransfer, getTransfer

  **Must NOT do**:
  - Do NOT expose raw API responses (wrap in domain types)

  **Parallelizable**: NO (depends on 1, 2)

  **References**:
  - `../bridge-mcp/src/bridge-client.ts` - Already created Bridge client
  - `src/services/ibex/client.ts:12-18` - Pattern for client initialization
  - `src/config/yaml.ts:389` - How to access config

  **Acceptance Criteria**:
  - [ ] Client initializes with config
  - [ ] All CRUD methods work
  - [ ] Errors are properly wrapped
  - [ ] `yarn tsc-check` passes

  **Commit**: YES
  - Message: `feat(bridge): add Bridge API client`
  - Files: `src/services/bridge/client.ts`

---

- [ ] 4. Create Bridge error types

  **What to do**:
  - Create `src/services/bridge/errors.ts`
  - Define: BridgeError, BridgeApiError, BridgeCustomerNotFoundError, BridgeInsufficientFundsError
  - Add error handler function

  **Must NOT do**:
  - Do NOT log sensitive data in errors

  **Parallelizable**: NO (depends on 2)

  **References**:
  - `src/services/ibex/errors.ts` - Pattern for service errors
  - `src/domain/errors.ts` - Base error classes

  **Acceptance Criteria**:
  - [ ] All error types defined
  - [ ] Error handler converts API errors
  - [ ] Errors extend DomainError
  - [ ] `yarn tsc-check` passes

  **Commit**: YES
  - Message: `feat(bridge): add Bridge error types`
  - Files: `src/services/bridge/errors.ts`

---

- [ ] 5. Create Bridge repository

  **What to do**:
  - Create `src/services/mongoose/bridge-accounts.ts`
  - Define BridgeAccountRecord schema (links Flash account to Bridge customer)
  - Define BridgeVirtualAccountRecord schema
  - Define BridgeExternalAccountRecord schema
  - Implement CRUD operations

  **Must NOT do**:
  - Do NOT store full bank account numbers (only last 4)

  **Parallelizable**: NO (depends on 2)

  **References**:
  - `src/services/mongoose/wallets.ts` - Repository pattern
  - `src/services/mongoose/accounts.ts` - Account repository pattern

  **Acceptance Criteria**:
  - [ ] Mongoose schemas defined
  - [ ] Repository functions work
  - [ ] Indexes on accountId, bridgeCustomerId
  - [ ] `yarn tsc-check` passes

  **Commit**: YES
  - Message: `feat(bridge): add Bridge account repository`
  - Files: `src/services/mongoose/bridge-accounts.ts`, `src/services/mongoose/schema.ts`

---

- [ ] 6. Add bridgeCustomerId to Account schema

  **What to do**:
  - Add `bridgeCustomerId` field to Account mongoose schema
  - Add to Account type definition
  - Update AccountsRepository to handle new field

  **Must NOT do**:
  - Do NOT make bridgeCustomerId required (lazy creation)

  **Parallelizable**: NO (depends on 2)

  **References**:
  - `src/services/mongoose/schema.ts` - Account schema
  - `src/domain/accounts/index.types.d.ts` - Account type
  - `src/services/mongoose/accounts.ts` - AccountsRepository

  **Acceptance Criteria**:
  - [ ] bridgeCustomerId field added to schema (optional)
  - [ ] Type definition updated
  - [ ] Repository handles field
  - [ ] `yarn tsc-check` passes

  **Commit**: YES
  - Message: `feat(accounts): add bridgeCustomerId field`
  - Files: `src/services/mongoose/schema.ts`, `src/domain/accounts/index.types.d.ts`, `src/services/mongoose/accounts.ts`

---

- [ ] 7. Create Bridge service layer

  **What to do**:
  - Create `src/services/bridge/index.ts` - public API
  - Implement: createBridgeCustomer, createVirtualAccount, createExternalAccount, initiateWithdrawal
  - Wire up client, repository, and error handling
  - Add logging with pino

  **Must NOT do**:
  - Do NOT expose internal implementation details

  **Parallelizable**: NO (depends on 3, 4, 5, 6)

  **References**:
  - `src/services/ibex/index.ts` - Service export pattern
  - `src/services/ledger/index.ts` - Complex service pattern

  **Acceptance Criteria**:
  - [ ] All public methods implemented
  - [ ] Proper error handling
  - [ ] Logging for all operations
  - [ ] `yarn tsc-check` passes

  **Commit**: YES
  - Message: `feat(bridge): add Bridge service layer`
  - Files: `src/services/bridge/index.ts`

---

- [ ] 8. Create Bridge webhook server

  **What to do**:
  - Create `src/services/bridge/webhook-server/index.ts`
  - Create routes: `/deposit`, `/transfer`
  - Create middleware: signature verification, logging
  - Handle: deposit.completed, transfer.completed webhooks
  - On deposit: credit user wallet (TODO: determine IBEX integration)

  **Must NOT do**:
  - Do NOT process webhooks without signature verification
  - Do NOT credit wallet without idempotency check

  **Parallelizable**: YES (with 9, after 7)

  **References**:
  - `src/services/ibex/webhook-server/` - Webhook server pattern
  - `src/services/ibex/webhook-server/middleware/authenticate.ts` - Auth pattern
  - Bridge webhook docs: https://apidocs.bridge.xyz/api-reference/webhooks

  **Acceptance Criteria**:
  - [ ] Server starts and accepts webhooks
  - [ ] Signature verification works
  - [ ] Deposit webhook credits wallet
  - [ ] Transfer webhook updates status
  - [ ] Idempotency prevents duplicate processing

  **Commit**: YES
  - Message: `feat(bridge): add webhook server for Bridge events`
  - Files: `src/services/bridge/webhook-server/index.ts`, `src/services/bridge/webhook-server/routes/`, `src/services/bridge/webhook-server/middleware/`

---

- [ ] 9. Add GraphQL endpoints for Bridge

  **What to do**:
  - Create `src/graphql/public/root/mutation/bridge-*.ts` mutations
  - Create `src/graphql/public/root/query/bridge-*.ts` queries
  - Add types: BridgeVirtualAccount, BridgeExternalAccount
  - Mutations: bridgeCreateVirtualAccount, bridgeCreateExternalAccount, bridgeInitiateWithdrawal
  - Queries: bridgeVirtualAccount, bridgeExternalAccounts

  **Must NOT do**:
  - Do NOT expose internal IDs or sensitive bank details
  - Do NOT allow operations without authentication

  **Parallelizable**: YES (with 8, after 7)

  **References**:
  - `src/graphql/public/root/mutation/` - Mutation pattern
  - `src/graphql/public/root/query/` - Query pattern
  - `src/graphql/public/types/object/` - Type definitions

  **Acceptance Criteria**:
  - [ ] All mutations work
  - [ ] All queries work
  - [ ] Proper authentication required
  - [ ] Error handling returns proper codes
  - [ ] `yarn tsc-check` passes

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
  - [ ] Address is valid TRC-20 format
  - [ ] `yarn tsc-check` passes

  **Commit**: YES
  - Message: `feat(ibex): add crypto receive methods for Tron USDT`
  - Files: `src/services/ibex/client.ts`, `src/services/ibex/types.ts`

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
| 1 | `feat(config): add Bridge.xyz configuration schema` | config/* | yarn tsc-check |
| 2 | `feat(bridge): add TypeScript types for Bridge entities` | services/bridge/*.d.ts | yarn tsc-check |
| 3 | `feat(bridge): add Bridge API client` | services/bridge/client.ts | yarn tsc-check |
| 4 | `feat(bridge): add Bridge error types` | services/bridge/errors.ts | yarn tsc-check |
| 5 | `feat(bridge): add Bridge account repository` | services/mongoose/* | yarn tsc-check |
| 6 | `feat(accounts): add bridgeCustomerId field` | mongoose/*, domain/* | yarn tsc-check |
| 7 | `feat(bridge): add Bridge service layer` | services/bridge/index.ts | yarn tsc-check |
| 8 | `feat(bridge): add webhook server for Bridge events` | services/bridge/webhook-server/* | yarn tsc-check |
| 9 | `feat(graphql): add Bridge API endpoints` | graphql/public/* | yarn tsc-check |
| 10 | `feat(ibex): add crypto receive methods for Tron USDT` | services/ibex/* | yarn tsc-check |
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

### Bridge Virtual Account Flow
```
1. User has Bridge customer_id and IBEX Tron address
2. Call POST /customers/{id}/virtual_accounts:
   - source.currency: "usd"
   - destination.currency: "usdt"
   - destination.payment_rail: "tron"
   - destination.address: user's IBEX Tron address
3. Returns: Bank details (routing#, account#) for ACH/Wire
4. User sends fiat → Bridge converts → USDT arrives at IBEX wallet
```

### Fee Calculation
```
user_receives = deposit_amount - bridge_fee - (deposit_amount * 0.005)
flash_revenue = deposit_amount * 0.005  // 0.5% markup
```
