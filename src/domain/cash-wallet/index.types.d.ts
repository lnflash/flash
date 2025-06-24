/**
 * SMART_ROUTER: Implementation Plan for Milestone 1
 *
 * Files to create:
 * 1. src/domain/cash-wallet/index.types.d.ts - Core type definitions
 * 2. src/domain/cash-wallet/index.ts - Constants and enums
 * 3. src/domain/cash-wallet/errors.ts - Error types and classes
 *
 * Security considerations:
 * - Token types must support encryption metadata
 * - Balance types must prevent numeric overflow
 * - All external data types need validation markers
 * - Adapter types must include authentication requirements
 *
 * Testing approach:
 * - Type compilation tests
 * - Type guard validation tests
 * - Interface contract tests
 *
 * Rollback plan:
 * - Remove src/domain/cash-wallet directory
 * - No breaking changes to existing code
 *
 * @milestone 1
 * @estimated-loc 200
 * @security-impact low
 */

/**
 * SMART_ROUTER: Core Type Definitions
 *
 * Purpose: Define fundamental types for the Smart Router feature including
 * adapters, routing, tokens, and balance management.
 *
 * Security: All types designed with security-first principles:
 * - Sensitive data types marked for encryption
 * - Input validation types for external data
 * - Authentication requirements explicit
 *
 * Dependencies:
 * - Domain primitive types (AccountId, WalletId, etc.)
 * - Payment amount types from existing domain
 *
 * Side Effects:
 * - None (type definitions only)
 *
 * @since smart-router-v1
 * @security-review pending
 * @milestone 1
 */

/**
 * SMART_ROUTER: Adapter Type Enum
 *
 * Purpose: Identifies the type of payment adapter for routing decisions
 * and capability checking.
 *
 * Security: Used for adapter validation and security policy enforcement
 *
 * @since smart-router-v1
 */
type AdapterType =
  (typeof import("./index").AdapterType)[keyof typeof import("./index").AdapterType]

/**
 * SMART_ROUTER: Routing Strategy Enum
 *
 * Purpose: Defines different routing strategies for payment optimization
 *
 * Security: Strategy selection affects privacy and security characteristics
 *
 * @since smart-router-v1
 */
type RoutingStrategy =
  (typeof import("./index").RoutingStrategy)[keyof typeof import("./index").RoutingStrategy]

/**
 * SMART_ROUTER: Type Aliases for Security and Type Safety
 *
 * Purpose: Define branded types for cash wallet identifiers following
 * the pattern used throughout the Flash codebase.
 *
 * Security: Branded types prevent accidental mixing of different ID types
 *
 * @since smart-router-v1
 */
type CashWalletId = string & { readonly brand: unique symbol }
type AdapterId = string & { readonly brand: unique symbol }
type RouteId = string & { readonly brand: unique symbol }
type TokenId = string & { readonly brand: unique symbol }
type MintUrl = string & { readonly brand: unique symbol }

/**
 * SMART_ROUTER: Balance Types
 *
 * Purpose: Represent balances from different sources with overflow protection
 *
 * Security:
 * - Uses bigint to prevent numeric overflow attacks
 * - Includes validation metadata
 * - Tracks last sync for freshness validation
 *
 * @since smart-router-v1
 */
interface Balance {
  /** Amount in satoshis - using bigint to prevent overflow */
  readonly amount: bigint

  /** Currency type for validation */
  readonly currency: WalletCurrency

  /** Whether this balance is available for spending */
  readonly available: boolean

  /** Timestamp of last balance update */
  readonly lastSync: Date

  /** Source adapter that provided this balance */
  readonly source: AdapterId
}

/**
 * SMART_ROUTER: Aggregated Cash Balance
 *
 * Purpose: Combined balance view from all adapters with detailed breakdown
 *
 * Security: Includes validation metadata and sync status
 *
 * @since smart-router-v1
 */
interface CashBalance {
  /** Total available balance across all sources */
  readonly total: bigint

  /** Breakdown by adapter source */
  readonly breakdown: {
    readonly custodial: Balance[]
    readonly eCash: ECashBalance
  }

  /** Last successful sync across all adapters */
  readonly lastSync: Date

  /** Whether any adapters are currently syncing */
  readonly syncing: boolean
}

/**
 * SMART_ROUTER: eCash Balance Details
 *
 * Purpose: Specific balance information for Cashu tokens
 *
 * Security: Includes token metadata without exposing sensitive proof data
 *
 * @since smart-router-v1
 */
interface ECashBalance {
  /** Total value of all tokens */
  readonly total: bigint

  /** Number of individual tokens held */
  readonly tokenCount: number

  /** Balance breakdown by mint */
  readonly byMint: Map<MintUrl, bigint>

  /** Oldest token timestamp for rotation planning */
  readonly oldestToken?: Date

  /** Newest token timestamp */
  readonly newestToken?: Date
}

/**
 * SMART_ROUTER: Route Type Enum
 *
 * Purpose: Categorizes payment routes for analytics and optimization
 *
 * @since smart-router-v1
 */
type RouteType =
  (typeof import("./index").RouteType)[keyof typeof import("./index").RouteType]

/**
 * SMART_ROUTER: Payment Adapter Capabilities
 *
 * Purpose: Describes what operations an adapter supports for routing decisions
 *
 * Security: Capabilities affect which routes are considered safe/available
 *
 * @since smart-router-v1
 */
interface AdapterCapabilities {
  /** Can operate without internet connection */
  readonly supportsOffline: boolean

  /** Can send/receive Lightning payments */
  readonly supportsLightning: boolean

  /** Can handle Cashu eCash tokens */
  readonly supportsCashu: boolean

  /** Can participate in split payments */
  readonly supportsSplitPayments: boolean

  /** Maximum amount this adapter can send (in satoshis) */
  readonly maxSendAmount?: bigint

  /** Minimum amount this adapter can send (in satoshis) */
  readonly minSendAmount?: bigint

  /** Average time to complete a payment (in milliseconds) */
  readonly avgPaymentTime: number

  /** Base fee for using this adapter (in satoshis) */
  readonly baseFee: bigint

  /** Fee rate as parts per million */
  readonly feeRate: number
}

/**
 * SMART_ROUTER: Fee Estimate
 *
 * Purpose: Estimated fees for a payment route
 *
 * Security: Fee calculations must be deterministic and auditable
 *
 * @since smart-router-v1
 */
interface FeeEstimate {
  /** Base fee in satoshis */
  readonly baseFee: bigint

  /** Proportional fee in satoshis */
  readonly proportionalFee: bigint

  /** Total estimated fee */
  readonly totalFee: bigint

  /** Confidence level of estimate (0-1) */
  readonly confidence: number

  /** Timestamp when estimate was calculated */
  readonly calculatedAt: Date
}

/**
 * SMART_ROUTER: Payment Route
 *
 * Purpose: Represents a possible path for executing a payment
 *
 * Security: Routes must include all security metadata for validation
 *
 * @since smart-router-v1
 */
interface PaymentRoute {
  /** Unique identifier for this route */
  readonly id: RouteId

  /** Type of route (single, split, swap) */
  readonly type: RouteType

  /** Adapters involved in this route */
  readonly adapters: AdapterId[]

  /** Payment amount in satoshis */
  readonly amount: bigint

  /** Estimated fees for this route */
  readonly fees: FeeEstimate

  /** Estimated completion time in milliseconds */
  readonly estimatedTime: number

  /** Route score for comparison (higher is better) */
  readonly score: number

  /** Whether this route requires internet connectivity */
  readonly requiresOnline: boolean

  /** Privacy level of this route (1-5, higher is more private) */
  readonly privacyLevel: number

  /** Additional metadata for route execution */
  readonly metadata: Record<string, unknown>
}

/**
 * SMART_ROUTER: Payment Recipient
 *
 * Purpose: Represents the destination for a payment with capabilities
 *
 * Security: Recipient validation is critical for preventing payment errors
 *
 * @since smart-router-v1
 */
interface PaymentRecipient {
  /** Type of recipient (lightning_invoice, cashu_token, on_chain, etc.) */
  readonly type: string

  /** Recipient identifier (invoice, address, etc.) */
  readonly identifier: string

  /** Whether recipient supports split payments */
  readonly supportsSplitPayments: boolean

  /** Preferred payment methods in order of preference */
  readonly preferredMethods: AdapterType[]

  /** Amount if specified by recipient (e.g., in invoice) */
  readonly amount?: bigint

  /** Expiry time for time-sensitive recipients */
  readonly expiresAt?: Date

  /** Additional recipient metadata */
  readonly metadata: Record<string, unknown>
}
