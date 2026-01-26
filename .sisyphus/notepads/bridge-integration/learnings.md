# Bridge Integration - Learnings & Conventions

## Timestamp
Started: 2026-01-26T11:47:17.806Z

## Patterns Discovered

### Task 1: Bridge Configuration Schema

#### Config Type Structure
- Types defined in `schema.types.d.ts` with nested object types
- `BridgeConfig` contains: `enabled`, `apiKey`, `baseUrl`, `webhook`
- `BridgeWebhook` contains: `port`, `publicKeys`, `timestampSkewMs`
- Per-endpoint webhook public keys: `{ kyc: string, deposit: string, transfer: string }`

#### Schema Validation Pattern
- JSON Schema validation in `schema.ts` mirrors TypeScript types
- Required fields specified in `required` array
- Nested objects use `properties` with recursive structure
- Schema added to main `required` array at end of file (line 747)

#### Config Export Pattern
- Configs exported as const objects (NOT functions)
- Pattern: `export const BridgeConfig = yamlConfig.bridge as BridgeConfig`
- Matches IbexConfig, SendGridConfig, FrappeConfig pattern
- Type assertion ensures type safety

#### YAML Config Defaults
- Placeholder values: `<replace>` for sensitive data (API keys, public keys)
- Feature flag: `enabled: false` for runtime control
- Default baseUrl: `https://api.bridge.xyz`
- Default webhook port: `4009` (different from Ibex's 4008)
- Default timestampSkewMs: `300000` (5 minutes)

#### Files Modified
1. `src/config/schema.types.d.ts` - Added 3 new types (BridgeWebhookPublicKeys, BridgeWebhook, BridgeConfig)
2. `src/config/schema.ts` - Added Bridge schema validation + required field
3. `src/config/yaml.ts` - Added BridgeConfig export
4. `dev/config/base-config.yaml` - Added Bridge section with defaults

#### Verification
- LSP diagnostics: No errors in modified files
- Type checking: `yarn tsc-check` passes (pre-existing test errors unrelated)
- Config structure validated against schema


### Task 2: Bridge TypeScript Types

#### Domain Primitives Pattern
- Branded ID types defined in `src/domain/primitives/bridge.ts`
- Pattern: `type BridgeCustomerId = string & { readonly brand: unique symbol }`
- Helper functions for type casting: `toBridgeCustomerId()`, `toBridgeVirtualAccountId()`, etc.
- Follows existing pattern from `src/domain/primitives/index.types.d.ts` (AccountId, WalletId, etc.)

#### Branded ID Types Created
1. `BridgeCustomerId` - Bridge customer identifier
2. `BridgeVirtualAccountId` - Virtual account identifier
3. `BridgeExternalAccountId` - External bank account identifier
4. `BridgeTransferId` - Transfer transaction identifier

#### Service Layer Types
- Defined in `src/services/bridge/index.types.d.ts`
- Imports branded IDs from domain layer (proper separation)
- Service interfaces for API responses:
  - `BridgeCustomer` - Customer profile with metadata
  - `BridgeVirtualAccount` - Virtual account details (account/routing numbers)
  - `BridgeExternalAccount` - External bank account (pending/verified/failed status)
  - `BridgeTransfer` - Transfer transaction with status tracking

#### Webhook Event Types
- Discriminated union type: `BridgeWebhookEventType`
- Event types implemented:
  - `BridgeKycApprovedEvent` (kyc.approved)
  - `BridgeKycRejectedEvent` (kyc.rejected)
  - `BridgeDepositCompletedEvent` (deposit.completed)
  - `BridgeTransferCompletedEvent` (transfer.completed)
  - `BridgeTransferFailedEvent` (transfer.failed)
- Each event has typed data payload with relevant IDs and metadata

#### Type Visibility
- Domain primitives importable from `@domain/primitives/bridge`
- Service types importable from `@services/bridge`
- Proper layering: domain types don't depend on service types
- Service types depend on domain primitives (correct direction)

#### Files Created
1. `src/domain/primitives/bridge.ts` - 22 lines (branded IDs + helpers)
2. `src/services/bridge/index.types.d.ts` - 115 lines (service interfaces + webhook events)

#### Verification
- LSP diagnostics: No errors in either file
- Type checking: `yarn tsc-check` passes (pre-existing test errors unrelated)
- Ready for domain layer integration (e.g., Account schema)

